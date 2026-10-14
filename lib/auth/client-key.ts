/**
 * Best-effort caller identity for rate limiting. LAN-only deployment behind
 * Caddy (see deploy/), which sets X-Forwarded-For; without a proxy every
 * caller shares one bucket, which is still a strictly-worse-than-nothing
 * fallback, not a broken one.
 */

// Rate-limit bucket keys are "<namespace>:<source>" (see lib/auth/admin.ts,
// lib/auth/webhook.ts and AlarmEngine's pinBucket). This header is fully
// caller-controlled, so a ":" inside it would let a caller write failures
// into another guard's namespace — e.g. flooding /api/disarm with
// "webhook:<the console's address>" to lock out the real UniFi sensor
// webhook, silently dropping every sensor trip while the system is armed.
// Reproduced against a real build before this was neutralized. IPv6 sources
// get mangled into an equivalent "_"-separated form, which is harmless: this
// value is only ever a map key, never parsed back into an address.
const MAX_SOURCE_LEN = 100;

export function clientKey(req: Request): string {
  const raw = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  return raw.replace(/:/g, "_").slice(0, MAX_SOURCE_LEN);
}
