import { db } from "../database/index.js";
import {
  promoCodes,
  promoCodeRuleSets,
  promoCodeRuleItems,
  promoCodeUsages,
} from "../database/schema.js";
import { eq, and, or, count, lt } from "drizzle-orm";

// TTL for pending promo reservations (configurable via env, default 15 min)
const PROMO_PENDING_TTL_MS = parseInt(process.env.PROMO_PENDING_TTL_MINUTES || "15", 10) * 60 * 1000;

export interface PromoValidationResult {
  valid: boolean;
  error?: string;
  promoCodeId?: number;
  discountType?: "percentage" | "fixed";
  discountValue?: number;       // percentage value or fixed amount (in order currency)
  discountAmount?: number;      // actual calculated discount in order currency
  netAmount?: number;           // subtotal - discountAmount
}

/**
 * Expire pending usages that have passed their TTL (on-request cleanup).
 */
export async function cleanupExpiredUsages(): Promise<void> {
  const now = new Date();
  await db
    .update(promoCodeUsages)
    .set({ status: "expired", cancelledAt: now })
    .where(
      and(
        eq(promoCodeUsages.status, "pending"),
        lt(promoCodeUsages.expiresAt, now) // expires_at < now
      )
    );
}

/**
 * Validate and calculate discount for a promo code.
 * Does NOT create a usage record — that's done separately in create-intent.
 */
export async function validatePromoCode(
  code: string,
  userId: number,
  currency: "THB" | "USD",
  subtotal: number,
  selectedTicketTypeIds: number[],
): Promise<PromoValidationResult> {
  // 1. Clean up expired pending usages first
  await cleanupExpiredUsages();

  // 2. Find the promo code
  const [promo] = await db
    .select()
    .from(promoCodes)
    .where(eq(promoCodes.code, code.toUpperCase()))
    .limit(1);

  if (!promo) {
    return { valid: false, error: "Promo code not found" };
  }

  // 3. Check isActive
  if (!promo.isActive) {
    return { valid: false, error: "Promo code is inactive" };
  }

  // 4. Check date validity
  const now = new Date();
  if (promo.validFrom && now < new Date(promo.validFrom)) {
    return { valid: false, error: "Promo code is not yet valid" };
  }
  if (promo.validUntil && now > new Date(promo.validUntil)) {
    return { valid: false, error: "Promo code has expired" };
  }

  // 5. Check global usage limit (count used + pending that haven't expired)
  const [globalUsage] = await db
    .select({ total: count() })
    .from(promoCodeUsages)
    .where(
      and(
        eq(promoCodeUsages.promoCodeId, promo.id),
        or(
          eq(promoCodeUsages.status, "used"),
          eq(promoCodeUsages.status, "pending")
        )
      )
    );

  if (globalUsage.total >= promo.maxUses) {
    return { valid: false, error: "Promo code usage limit reached" };
  }

  // 6. Check per-user usage limit
  const [userUsage] = await db
    .select({ total: count() })
    .from(promoCodeUsages)
    .where(
      and(
        eq(promoCodeUsages.promoCodeId, promo.id),
        eq(promoCodeUsages.userId, userId),
        or(
          eq(promoCodeUsages.status, "used"),
          eq(promoCodeUsages.status, "pending")
        )
      )
    );

  if (userUsage.total >= promo.maxUsesPerUser) {
    return { valid: false, error: "You have already used this promo code" };
  }

  // 7. Check min purchase
  const minPurchase = Number(promo.minPurchase || 0);
  if (subtotal < minPurchase) {
    return { valid: false, error: `Minimum purchase of ${minPurchase} ${currency} required` };
  }

  // 8. Check rule sets (ticket applicability)
  const ruleSets = await db
    .select()
    .from(promoCodeRuleSets)
    .where(eq(promoCodeRuleSets.promoCodeId, promo.id));

  if (ruleSets.length > 0) {
    // At least ONE rule set must match
    let anyRuleSetMatched = false;

    for (const rs of ruleSets) {
      const ruleItems = await db
        .select({ ticketTypeId: promoCodeRuleItems.ticketTypeId })
        .from(promoCodeRuleItems)
        .where(eq(promoCodeRuleItems.ruleSetId, rs.id));

      const ruleTicketIds = ruleItems.map(ri => ri.ticketTypeId);
      const selectedSet = new Set(selectedTicketTypeIds);
      const ruleSet = new Set(ruleTicketIds);

      if (rs.matchType === "all") {
        // All rule items must be in selected
        const allPresent = ruleTicketIds.every(id => selectedSet.has(id));
        if (allPresent) { anyRuleSetMatched = true; break; }
      } else if (rs.matchType === "any") {
        // At least one rule item must be in selected
        const anyPresent = ruleTicketIds.some(id => selectedSet.has(id));
        if (anyPresent) { anyRuleSetMatched = true; break; }
      } else if (rs.matchType === "only") {
        // Selected must exactly equal rule items
        const exactMatch = selectedTicketTypeIds.length === ruleTicketIds.length &&
          selectedTicketTypeIds.every(id => ruleSet.has(id));
        if (exactMatch) { anyRuleSetMatched = true; break; }
      }
    }

    if (!anyRuleSetMatched) {
      return { valid: false, error: "Promo code does not apply to selected tickets" };
    }
  }

  // 9. Calculate discount
  let discountAmount: number;
  let discountValue: number;

  if (promo.discountType === "percentage") {
    discountValue = Number(promo.discountValue);
    discountAmount = Math.round(subtotal * discountValue / 100 * 100) / 100;

    // Apply maxDiscount cap
    if (promo.maxDiscount) {
      const maxDisc = Number(promo.maxDiscount);
      if (discountAmount > maxDisc) {
        discountAmount = maxDisc;
      }
    }
  } else {
    // fixed discount — use currency-specific value
    if (currency === "THB") {
      discountValue = Number(promo.fixedValueThb || promo.discountValue || 0);
    } else {
      discountValue = Number(promo.fixedValueUsd || promo.discountValue || 0);
    }
    discountAmount = discountValue;
  }

  // Don't let discount exceed subtotal
  if (discountAmount > subtotal) {
    discountAmount = subtotal;
  }

  discountAmount = Math.round(discountAmount * 100) / 100;
  const netAmount = Math.round((subtotal - discountAmount) * 100) / 100;

  return {
    valid: true,
    promoCodeId: promo.id,
    discountType: promo.discountType as "percentage" | "fixed",
    discountValue,
    discountAmount,
    netAmount,
  };
}

/**
 * Create a pending promo code usage reservation.
 * Returns the usage ID for later settlement.
 */
export async function reservePromoUsage(
  promoCodeId: number,
  userId: number,
  orderId: number,
  discountAmount: number,
): Promise<number> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + PROMO_PENDING_TTL_MS);

  const [usage] = await db.insert(promoCodeUsages).values({
    promoCodeId,
    userId,
    orderId,
    status: "pending",
    discountAmount: discountAmount.toString(),
    reservedAt: now,
    expiresAt,
  }).returning();

  return usage.id;
}

/**
 * Settle a promo code usage after successful payment (idempotent).
 * Increments usedCount on the promo_codes table.
 */
export async function settlePromoUsageSuccess(orderId: number): Promise<void> {
  // Find pending usage for this order
  const [usage] = await db
    .select()
    .from(promoCodeUsages)
    .where(
      and(
        eq(promoCodeUsages.orderId, orderId),
        eq(promoCodeUsages.status, "pending")
      )
    )
    .limit(1);

  if (!usage) return; // Already settled or no promo used

  const now = new Date();

  // Mark as used
  await db
    .update(promoCodeUsages)
    .set({ status: "used", usedAt: now })
    .where(eq(promoCodeUsages.id, usage.id));

  // Increment usedCount on promo_codes
  const [promo] = await db
    .select({ usedCount: promoCodes.usedCount })
    .from(promoCodes)
    .where(eq(promoCodes.id, usage.promoCodeId))
    .limit(1);

  if (promo) {
    await db
      .update(promoCodes)
      .set({ usedCount: promo.usedCount + 1 })
      .where(eq(promoCodes.id, usage.promoCodeId));
  }
}

/**
 * Cancel a promo code usage (when order is cancelled/failed).
 */
export async function cancelPromoUsage(orderId: number): Promise<void> {
  const now = new Date();
  await db
    .update(promoCodeUsages)
    .set({ status: "cancelled", cancelledAt: now })
    .where(
      and(
        eq(promoCodeUsages.orderId, orderId),
        or(
          eq(promoCodeUsages.status, "pending"),
          eq(promoCodeUsages.status, "expired")
        )
      )
    );
}
