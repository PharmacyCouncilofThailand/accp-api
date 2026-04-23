/**
 * NipaMail Credentials Diagnostic Script
 *
 * Usage:
 *   npx tsx src/scripts/test-nipamail-auth.ts
 *
 * Purpose:
 *   Verify NIPAMAIL_CLIENT_ID and NIPAMAIL_CLIENT_SECRET in .env are valid
 *   by calling the token endpoint directly (same flow as emailService.ts).
 */

import * as dotenv from "dotenv";
dotenv.config();

import axios, { AxiosError } from "axios";

const NIPAMAIL_API_URL = "https://api.nipamail.com";

function mask(value: string | undefined, visible = 4): string {
  if (!value) return "(not set)";
  if (value.length <= visible) return "*".repeat(value.length);
  return value.slice(0, visible) + "*".repeat(Math.max(0, value.length - visible));
}

async function main() {
  console.log("========================================");
  console.log("  NipaMail Auth Diagnostic");
  console.log("========================================\n");

  const clientId = process.env.NIPAMAIL_CLIENT_ID;
  const clientSecret = process.env.NIPAMAIL_CLIENT_SECRET;
  const senderEmail = process.env.NIPAMAIL_SENDER_EMAIL;

  console.log("Environment variables:");
  console.log(`  NIPAMAIL_CLIENT_ID     : ${mask(clientId, 6)}`);
  console.log(`  NIPAMAIL_CLIENT_SECRET : ${mask(clientSecret, 4)}`);
  console.log(`  NIPAMAIL_SENDER_EMAIL  : ${senderEmail || "(not set)"}`);
  console.log(`  API URL                : ${NIPAMAIL_API_URL}\n`);

  if (!clientId || !clientSecret) {
    console.error("[X] Missing credentials in .env");
    console.error("    Set NIPAMAIL_CLIENT_ID and NIPAMAIL_CLIENT_SECRET");
    process.exit(1);
  }

  console.log(`[*] Requesting new access token from ${NIPAMAIL_API_URL}/v1/auth/tokens ...\n`);

  try {
    const response = await axios.post(
      `${NIPAMAIL_API_URL}/v1/auth/tokens`,
      new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
      {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        timeout: 10000,
      }
    );

    console.log("[OK] Token request succeeded");
    console.log(`     HTTP Status   : ${response.status}`);
    console.log(`     Token         : ${mask(response.data.access_token, 10)}`);
    console.log(`     Token Type    : ${response.data.token_type || "(not returned)"}`);
    console.log(`     Expires In    : ${response.data.expires_in || "(not returned)"} seconds`);
    console.log(`     Full response keys: ${Object.keys(response.data).join(", ")}\n`);

    console.log("=> Credentials are VALID. Email sending should work.");
    console.log("   If emails still fail, check sender email domain verification in NipaMail dashboard.");
    process.exit(0);
  } catch (error) {
    console.error("[X] Token request FAILED\n");

    if (axios.isAxiosError(error)) {
      const axiosErr = error as AxiosError<any>;
      if (axiosErr.response) {
        console.error(`    HTTP Status   : ${axiosErr.response.status} ${axiosErr.response.statusText}`);
        console.error(`    Response body :`, JSON.stringify(axiosErr.response.data, null, 2));
        console.error(`    Response headers:`, JSON.stringify(axiosErr.response.headers, null, 2));

        const status = axiosErr.response.status;
        const msg = axiosErr.response.data?.message || axiosErr.response.data?.error;
        console.error("\n=> Likely cause:");
        if (status === 401 || /expired|invalid|unauthorized/i.test(msg || "")) {
          console.error("   CLIENT_SECRET is expired or revoked.");
          console.error("   Action: Go to NipaMail dashboard -> regenerate client secret -> update .env");
        } else if (status === 404) {
          console.error("   Endpoint not found. Check NIPAMAIL_API_URL (is it still https://api.nipamail.com?)");
        } else if (status >= 500) {
          console.error("   NipaMail server issue. Retry later.");
        } else {
          console.error("   Unknown auth error. Read response body above for details.");
        }
      } else if (axiosErr.request) {
        console.error("    No response received (network or timeout)");
        console.error(`    Code          : ${axiosErr.code}`);
        console.error(`    Message       : ${axiosErr.message}`);
        console.error("\n=> Likely cause: Network connectivity or firewall blocking outbound HTTPS");
      } else {
        console.error(`    Setup error   : ${axiosErr.message}`);
      }
    } else {
      console.error("    Non-Axios error:", error);
    }

    process.exit(2);
  }
}

main().catch((err) => {
  console.error("Unexpected failure:", err);
  process.exit(99);
});
