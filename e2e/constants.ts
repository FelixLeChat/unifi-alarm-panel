import { test } from "@playwright/test";

// Shared across global-setup.ts and the specs — must match playwright.config.ts's webServer env.
export const BASE_URL = "http://localhost:3177";
export const ADMIN_TOKEN = "e2e-admin-token";
export const WEBHOOK_SECRET = "e2e-webhook-secret";

// Seeded once in global-setup.ts; used by panel.spec.ts's arm/disarm flow.
// Exactly 4 digits — the admin API now rejects anything else (see
// app/api/admin/pins/route.ts).
export const STANDARD_PIN_LABEL = "E2E Standard";
export const STANDARD_PIN = "1357";
export const DURESS_PIN_LABEL = "E2E Duress";
export const DURESS_PIN = "2468";

let pinCounter = 0;
/**
 * A 4-digit code no other test in this run uses. An active duplicate is
 * refused with 409, and a retry re-runs the test against the same DB, so a
 * literal code would fail its own retry.
 */
export function freshPin(): string {
  pinCounter += 1;
  return String(4000 + pinCounter * 10 + test.info().retry);
}
