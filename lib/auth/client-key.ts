/**
 * Best-effort caller identity for rate limiting and audit. Not trustworthy:
 * Next only fills X-Forwarded-For from the socket when the request has none,
 * so a caller can send any value. Fine for the admin-token and webhook-secret
 * guards (long random secrets), which is why PIN lockout doesn't use it as
 * its bucket (see PIN_BUCKET in lib/engine/index.ts).
 */

// Rate-limit bucket keys are "<namespace>:<source>" (see lib/auth/admin.ts,
// lib/auth/webhook.ts and AlarmEngine's PIN_BUCKET). This header is fully
// caller-controlled, so a ":" inside it would let a caller write failures
// into another guard's namespace — e.g. flooding /api/disarm with
// "webhook:<the console's address>" to lock out the real UniFi sensor
// webhook, silently dropping every sensor trip while the system is armed.
// IPv6 sources
// get mangled into an equivalent "_"-separated form, which is harmless: this
// value is only ever a map key, never parsed back into an address.
const MAX_SOURCE_LEN = 100;

export function clientKey(req: Request): string {
  const raw = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return raw.replace(/:/g, "_").slice(0, MAX_SOURCE_LEN);
}
