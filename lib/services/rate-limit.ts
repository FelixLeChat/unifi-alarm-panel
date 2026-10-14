/**
 * Defeats shoulder-surf brute force on the kiosk keypad: a handful of wrong
 * PINs from the same source locks that source out for a while. In-memory —
 * single process, and a restart resetting attempt counters is an acceptable
 * trade for not adding a datastore just for this.
 */

import { getDb } from "@/lib/db";
import { getConfigValue } from "./config";

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_SEC = 5 * 60;
const DEFAULT_LOCKOUT_SEC = 5 * 60;

// Read fresh per call, not cached — same reasoning as protect-client.ts's
// getDispatcher(): these are rarely-hit config keys (a handful of auth
// attempts, not a hot loop), so there's no cost worth optimizing away, and a
// Settings-screen change should take effect on the very next attempt rather
// than waiting for a restart.
/**
 * A non-numeric value would otherwise make every comparison below false —
 * `failCount >= NaN` is never true, so a garbage rateLimitMaxAttempts would
 * silently disable the lockout entirely. Falls back to the default rather
 * than failing open.
 */
function readPositiveNumber(key: string, fallback: number): number {
  const parsed = Number(getConfigValue(getDb(), key) ?? fallback);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getMaxAttempts(): number {
  return readPositiveNumber("rateLimitMaxAttempts", DEFAULT_MAX_ATTEMPTS);
}

function getWindowMs(): number {
  return readPositiveNumber("rateLimitWindowSec", DEFAULT_WINDOW_SEC) * 1000;
}

function getLockoutMs(): number {
  return readPositiveNumber("rateLimitLockoutSec", DEFAULT_LOCKOUT_SEC) * 1000;
}

interface Bucket {
  failCount: number;
  firstFailAt: number;
  lockedUntil: number | null;
}

// Next/Turbopack compiles each route handler into its own bundle; a plain
// module-scoped `const` gives each bundle its own copy of `buckets` instead
// of one shared instance — same gotcha as lib/db/index.ts's __uapDb, and
// worse here specifically: verifyAdminToken (lib/auth/admin.ts) is called
// from many different admin route files, so a per-bundle copy would let a
// brute force spread across endpoints dodge the lockout by never hitting 5
// failures against any single copy. globalThis is the one thing actually
// shared by every bundle in the process.
declare global {
  var __uapRateLimitBuckets: Map<string, Bucket> | undefined;
}

function getBuckets(): Map<string, Bucket> {
  if (!globalThis.__uapRateLimitBuckets) {
    globalThis.__uapRateLimitBuckets = new Map();
  }
  return globalThis.__uapRateLimitBuckets;
}

export function isLockedOut(key: string): boolean {
  const buckets = getBuckets();
  const bucket = buckets.get(key);
  if (!bucket) return false;
  if (!bucket.lockedUntil) {
    // Failures that aged out of the window are dropped here, on read, not
    // only on the next failure: otherwise a later, longer window would bring
    // them back into the count.
    if (Date.now() - bucket.firstFailAt > getWindowMs()) buckets.delete(key);
    return false;
  }
  if (Date.now() >= bucket.lockedUntil) {
    buckets.delete(key);
    return false;
  }
  return true;
}

export function recordFailure(key: string): void {
  const buckets = getBuckets();
  const now = Date.now();
  const bucket = buckets.get(key);
  if (!bucket || now - bucket.firstFailAt > getWindowMs()) {
    buckets.set(key, { failCount: 1, firstFailAt: now, lockedUntil: null });
    return;
  }
  bucket.failCount += 1;
  if (bucket.failCount >= getMaxAttempts()) {
    bucket.lockedUntil = now + getLockoutMs();
  }
}

export function recordSuccess(key: string): void {
  getBuckets().delete(key);
}

/** How many more wrong attempts this source has before it locks out — for showing "N tries left" at the point of failure, not just a flat "locked out". */
export function getRemainingAttempts(key: string): number {
  const maxAttempts = getMaxAttempts();
  const bucket = getBuckets().get(key);
  if (!bucket || Date.now() - bucket.firstFailAt > getWindowMs()) return maxAttempts;
  return Math.max(0, maxAttempts - bucket.failCount);
}
