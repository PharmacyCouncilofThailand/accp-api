import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  integer,
  decimal,
  boolean,
  jsonb,
  pgEnum,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

// --------------------------------------------------------------------------
// 1. ENUMS
// --------------------------------------------------------------------------
export const userRoleEnum = pgEnum("user_role", [
  "admin",
  "thstd",
  "interstd",
  "thpro",
  "interpro",
]);
export const accountStatusEnum = pgEnum("account_status", [
  "pending_approval",
  "active",
  "rejected",
]);
export const eventStatusEnum = pgEnum("event_status", [
  "draft",
  "published",
  "cancelled",
  "completed",
]);
export const eventTypeEnum = pgEnum("event_type", [
  "single_room",
  "multi_session",
]);
export const ticketCategoryEnum = pgEnum("ticket_category", [
  "primary",
  "addon",
]);
export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "paid",
  "cancelled",
]);
export const orderItemTypeEnum = pgEnum("order_item_type", ["ticket", "addon"]);
export const registrationStatusEnum = pgEnum("registration_status", [
  "confirmed",
  "cancelled",
]);
export const abstractCategoryEnum = pgEnum("abstract_category", [
  "clinical_pharmacy",
  "social_administrative",
  "pharmaceutical_sciences",
  "pharmacology_toxicology",
  "pharmacy_education",
  "digital_pharmacy"
]);
export const presentationTypeEnum = pgEnum("presentation_type", [
  "oral",
  "poster",
]);
export const abstractStatusEnum = pgEnum("abstract_status", [
  "pending",
  "accepted",
  "rejected",
]);
export const speakerTypeEnum = pgEnum("speaker_type", [
  "keynote",
  "panelist",
  "moderator",
  "guest",
]);
export const staffRoleEnum = pgEnum("staff_role", [
  "admin",
  "organizer",
  "reviewer",
  "staff",
  "verifier",
]);
export const sessionTypeEnum = pgEnum("session_type", [
  "workshop",
  "gala_dinner",
  "lecture",
  "ceremony",
  "break",
  "other",
]);

// --------------------------------------------------------------------------
// 2. USER MANAGEMENT
// --------------------------------------------------------------------------
export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: userRoleEnum("role").notNull(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  phone: varchar("phone", { length: 20 }),
  country: varchar("country", { length: 100 }),
  institution: varchar("institution", { length: 255 }),
  thaiIdCard: varchar("thai_id_card", { length: 13 }).unique(),
  passportId: varchar("passport_id", { length: 20 }).unique(),
  pharmacyLicenseId: varchar("pharmacy_license_id", { length: 20 }).unique(),
  verificationDocUrl: varchar("verification_doc_url", { length: 500 }),
  status: accountStatusEnum("status").notNull().default("pending_approval"),
  rejectionReason: text("rejection_reason"),
  resubmissionCount: integer("resubmission_count").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 2A. PASSWORD RESET TOKENS
// --------------------------------------------------------------------------
export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  token: varchar("token", { length: 255 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 2B. BACKOFFICE STAFF
// --------------------------------------------------------------------------
export const backofficeUsers = pgTable("backoffice_users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: varchar("password_hash", { length: 255 }).notNull(),
  role: staffRoleEnum("role").notNull(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  conferenceCode: varchar("conference_code", { length: 100 }),
  // Categories that this reviewer is responsible for (only applicable for role = 'reviewer')
  assignedCategories: jsonb("assigned_categories").$type<string[]>().default([]),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 3. EVENTS & SESSIONS
// --------------------------------------------------------------------------
export const events = pgTable("events", {
  id: serial("id").primaryKey(),
  eventCode: varchar("event_code", { length: 50 }).notNull().unique(),
  eventName: varchar("event_name", { length: 255 }).notNull(),
  description: text("description"),
  eventType: eventTypeEnum("event_type").notNull(),
  location: varchar("location", { length: 255 }),
  category: varchar("category", { length: 100 }),
  startDate: timestamp("start_date").notNull(),
  endDate: timestamp("end_date").notNull(),
  maxCapacity: integer("max_capacity").notNull().default(100),
  conferenceCode: varchar("conference_code", { length: 100 }),
  cpeCredits: decimal("cpe_credits", { precision: 5, scale: 2 }).default("0"),
  status: eventStatusEnum("status").notNull().default("draft"),
  imageUrl: varchar("image_url", { length: 500 }),
  mapUrl: varchar("map_url", { length: 500 }),
  abstractStartDate: timestamp("abstract_start_date"),
  abstractEndDate: timestamp("abstract_end_date"),
  createdBy: integer("created_by").references(() => users.id),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  sessionCode: varchar("session_code", { length: 50 }).notNull(),
  sessionName: varchar("session_name", { length: 255 }).notNull(),
  sessionType: sessionTypeEnum("session_type").default("other"),
  isMainSession: boolean("is_main_session").notNull().default(false),
  description: text("description"),
  room: varchar("room", { length: 100 }),
  startTime: timestamp("start_time").notNull(),
  endTime: timestamp("end_time").notNull(),
  maxCapacity: integer("max_capacity").default(100),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const staffEventAssignments = pgTable("staff_event_assignments", {
  id: serial("id").primaryKey(),
  staffId: integer("staff_id")
    .notNull()
    .references(() => backofficeUsers.id, { onDelete: "cascade" }),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  sessionId: integer("session_id").references(() => sessions.id),
  assignedAt: timestamp("assigned_at").notNull().defaultNow(),
});

export const eventImages = pgTable("event_images", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  imageUrl: varchar("image_url", { length: 500 }).notNull(),
  caption: varchar("caption", { length: 255 }),
  imageType: varchar("image_type", { length: 50 }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const eventAttachments = pgTable("event_attachments", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  fileName: varchar("file_name", { length: 255 }).notNull(),
  fileUrl: varchar("file_url", { length: 500 }).notNull(),
  fileType: varchar("file_type", { length: 100 }),
  fileSize: integer("file_size"),
  description: varchar("description", { length: 500 }),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 4. TICKETS & PROMO CODES
// --------------------------------------------------------------------------
export const ticketTypes = pgTable("ticket_types", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  category: ticketCategoryEnum("category").notNull(),
  groupName: varchar("group_name", { length: 100 }),
  name: varchar("name", { length: 100 }).notNull(),
  sessionId: integer("session_id").references(() => sessions.id), // Deprecated: use ticketSessions for multi-session
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("THB"),
  allowedRoles: text("allowed_roles"),
  quota: integer("quota").notNull(),
  soldCount: integer("sold_count").notNull().default(0),
  saleStartDate: timestamp("sale_start_date"),
  saleEndDate: timestamp("sale_end_date"),
});

// Junction table for many-to-many: Ticket <-> Sessions
export const ticketSessions = pgTable("ticket_sessions", {
  id: serial("id").primaryKey(),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id, { onDelete: "cascade" }),
  sessionId: integer("session_id")
    .notNull()
    .references(() => sessions.id, { onDelete: "cascade" }),
});

export const promoCodes = pgTable("promo_codes", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id").references(() => events.id),
  ticketTypeId: integer("ticket_type_id").references(() => ticketTypes.id),
  code: varchar("code", { length: 50 }).notNull().unique(),
  description: text("description"),
  discountType: varchar("discount_type", { length: 20 }).notNull(),
  discountValue: decimal("discount_value", {
    precision: 10,
    scale: 2,
  }).notNull(),
  maxUses: integer("max_uses").notNull(),
  usedCount: integer("used_count").notNull().default(0),
  validFrom: timestamp("valid_from"),
  validUntil: timestamp("valid_until"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 5. ORDERS & PAYMENTS
// --------------------------------------------------------------------------
export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id),
  orderNumber: varchar("order_number", { length: 50 }).notNull().unique(),
  totalAmount: decimal("total_amount", { precision: 10, scale: 2 }).notNull(),
  currency: varchar("currency", { length: 3 }).notNull().default("THB"),
  status: orderStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 6. REGISTRATION & CHECK-IN
// --------------------------------------------------------------------------
export const registrations = pgTable("registrations", {
  id: serial("id").primaryKey(),
  regCode: varchar("reg_code", { length: 50 }).notNull().unique(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id),
  userId: integer("user_id").references(() => users.id),
  email: varchar("email", { length: 255 }).notNull(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  dietaryRequirements: varchar("dietary_requirements", { length: 255 }),
  status: registrationStatusEnum("status").notNull().default("confirmed"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const orderItems = pgTable("order_items", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .references(() => orders.id, { onDelete: "cascade" }),
  itemType: orderItemTypeEnum("item_type").notNull(),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id),
  registrationId: integer("registration_id").references(() => registrations.id),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  quantity: integer("quantity").notNull().default(1),
});

export const payments = pgTable("payments", {
  id: serial("id").primaryKey(),
  orderId: integer("order_id")
    .notNull()
    .references(() => orders.id),
  amount: decimal("amount", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status", { length: 20 }).notNull(),
  paymentChannel: varchar("payment_channel", { length: 50 }),
  paymentDetails: jsonb("payment_details"),
  stripeReceiptUrl: varchar("stripe_receipt_url", { length: 500 }),
  stripeSessionId: varchar("stripe_session_id", { length: 255 }),
  paidAt: timestamp("paid_at"),
});

export const registrationAddons = pgTable("registration_addons", {
  id: serial("id").primaryKey(),
  registrationId: integer("registration_id")
    .notNull()
    .references(() => registrations.id, { onDelete: "cascade" }),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id),
  price: decimal("price", { precision: 10, scale: 2 }).notNull(),
  status: varchar("status").default("active"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const checkIns = pgTable("check_ins", {
  id: serial("id").primaryKey(),
  registrationId: integer("registration_id")
    .notNull()
    .references(() => registrations.id, { onDelete: "cascade" }),
  ticketTypeId: integer("ticket_type_id")
    .notNull()
    .references(() => ticketTypes.id),
  scannedAt: timestamp("scanned_at").notNull().defaultNow(),
  scannedBy: integer("scanned_by").references(() => users.id),
});

// --------------------------------------------------------------------------
// 7. ABSTRACTS & SPEAKERS
// --------------------------------------------------------------------------
export const speakers = pgTable("speakers", {
  id: serial("id").primaryKey(),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  bio: text("bio"),
  photoUrl: varchar("photo_url", { length: 500 }),
  organization: varchar("organization", { length: 255 }),
  position: varchar("position", { length: 255 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const eventSpeakers = pgTable("event_speakers", {
  id: serial("id").primaryKey(),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  speakerId: integer("speaker_id")
    .notNull()
    .references(() => speakers.id),
  sessionId: integer("session_id").references(() => sessions.id),
  speakerType: speakerTypeEnum("speaker_type").notNull(),
  topic: varchar("topic", { length: 255 }),
  presentationFileUrl: varchar("presentation_file_url", { length: 500 }),
  sortOrder: integer("sort_order").notNull().default(0),
});

export const abstracts = pgTable("abstracts", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .references(() => users.id),
  eventId: integer("event_id")
    .notNull()
    .references(() => events.id),
  title: varchar("title", { length: 500 }).notNull(),
  category: abstractCategoryEnum("category").notNull(),
  presentationType: presentationTypeEnum("presentation_type").notNull(),
  keywords: varchar("keywords", { length: 255 }),
  background: text("background").notNull(),
  methods: text("methods").notNull(),
  results: text("results").notNull(),
  conclusion: text("conclusion").notNull(),
  fullPaperUrl: varchar("full_paper_url", { length: 500 }),
  status: abstractStatusEnum("status").notNull().default("pending"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const abstractCoAuthors = pgTable("abstract_co_authors", {
  id: serial("id").primaryKey(),
  abstractId: integer("abstract_id")
    .notNull()
    .references(() => abstracts.id, { onDelete: "cascade" }),
  firstName: varchar("first_name", { length: 100 }).notNull(),
  lastName: varchar("last_name", { length: 100 }).notNull(),
  email: varchar("email", { length: 255 }).notNull(),
  institution: varchar("institution", { length: 255 }),
  country: varchar("country", { length: 100 }),
  sortOrder: integer("sort_order").default(0),
});

export const abstractReviews = pgTable("abstract_reviews", {
  id: serial("id").primaryKey(),
  abstractId: integer("abstract_id")
    .notNull()
    .references(() => abstracts.id),
  reviewerId: integer("reviewer_id")
    .notNull()
    .references(() => users.id),
  status: abstractStatusEnum("status").notNull(),
  comment: text("comment"),
  reviewedAt: timestamp("reviewed_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// 8. VERIFICATION REJECTION HISTORY
// --------------------------------------------------------------------------
export const verificationRejectionHistory = pgTable("verification_rejection_history", {
  id: serial("id").primaryKey(),
  userId: integer("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  rejectedBy: integer("rejected_by").references(() => backofficeUsers.id),
  rejectedAt: timestamp("rejected_at").notNull().defaultNow(),
});

// --------------------------------------------------------------------------
// TYPE EXPORTS
// --------------------------------------------------------------------------
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

export type TicketType = typeof ticketTypes.$inferSelect;
export type NewTicketType = typeof ticketTypes.$inferInsert;

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;

export type Registration = typeof registrations.$inferSelect;
export type NewRegistration = typeof registrations.$inferInsert;

export type Speaker = typeof speakers.$inferSelect;
export type NewSpeaker = typeof speakers.$inferInsert;

export type Abstract = typeof abstracts.$inferSelect;
export type NewAbstract = typeof abstracts.$inferInsert;

export type BackofficeUser = typeof backofficeUsers.$inferSelect;
export type NewBackofficeUser = typeof backofficeUsers.$inferInsert;

export type StaffEventAssignment = typeof staffEventAssignments.$inferSelect;
export type NewStaffEventAssignment = typeof staffEventAssignments.$inferInsert;

export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// --------------------------------------------------------------------------
// 8. RELATIONS
// --------------------------------------------------------------------------

export const registrationsRelations = relations(registrations, ({ one }) => ({
  event: one(events, {
    fields: [registrations.eventId],
    references: [events.id],
  }),
  ticketType: one(ticketTypes, {
    fields: [registrations.ticketTypeId],
    references: [ticketTypes.id],
  }),
  user: one(users, {
    fields: [registrations.userId],
    references: [users.id],
  }),
}));

export const checkInsRelations = relations(checkIns, ({ one }) => ({
  registration: one(registrations, {
    fields: [checkIns.registrationId],
    references: [registrations.id],
  }),
  scannedBy: one(users, {
    fields: [checkIns.scannedBy],
    references: [users.id],
  }),
}));

export const eventsRelations = relations(events, ({ many }) => ({
  registrations: many(registrations),
  sessions: many(sessions),
  eventSpeakers: many(eventSpeakers),
  ticketTypes: many(ticketTypes),
}));

export const sessionsRelations = relations(sessions, ({ one, many }) => ({
  event: one(events, {
    fields: [sessions.eventId],
    references: [events.id],
  }),
  eventSpeakers: many(eventSpeakers),
}));

export const speakersRelations = relations(speakers, ({ many }) => ({
  eventSpeakers: many(eventSpeakers),
}));

export const eventSpeakersRelations = relations(eventSpeakers, ({ one }) => ({
  event: one(events, {
    fields: [eventSpeakers.eventId],
    references: [events.id],
  }),
  speaker: one(speakers, {
    fields: [eventSpeakers.speakerId],
    references: [speakers.id],
  }),
  session: one(sessions, {
    fields: [eventSpeakers.sessionId],
    references: [sessions.id],
  }),
}));

export const ticketTypesRelations = relations(ticketTypes, ({ many }) => ({
  registrations: many(registrations),
  ticketSessions: many(ticketSessions),
}));
