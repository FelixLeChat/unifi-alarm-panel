import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { setConfigValue } from "./config";
import { isLockedOut, recordFailure, recordSuccess } from "./rate-limit";

beforeEach(() => {
  vi.useFakeTimers();
  process.env.DATABASE_PATH = ":memory:";
  closeDb();
  delete globalThis.__uapRateLimitBuckets;
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

describe("rate-limit", () => {
  it("locks out after 5 failures from the same key", () => {
    const key = "10.0.0.1-a";
    for (let i = 0; i < 4; i++) {
      expect(isLockedOut(key)).toBe(false);
      recordFailure(key);
    }
    expect(isLockedOut(key)).toBe(false);
    recordFailure(key); // 5th failure
    expect(isLockedOut(key)).toBe(true);
  });

  it("a different key is unaffected", () => {
    const key = "10.0.0.1-b";
    for (let i = 0; i < 5; i++) recordFailure(key);
    expect(isLockedOut(key)).toBe(true);
    expect(isLockedOut("10.0.0.2-b")).toBe(false);
  });

  it("a success clears the failure count", () => {
    const key = "10.0.0.1-c";
    for (let i = 0; i < 4; i++) recordFailure(key);
    recordSuccess(key);
    recordFailure(key);
    expect(isLockedOut(key)).toBe(false);
  });

  it("the lockout expires", () => {
    const key = "10.0.0.1-d";
    for (let i = 0; i < 5; i++) recordFailure(key);
    expect(isLockedOut(key)).toBe(true);
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(isLockedOut(key)).toBe(false);
  });

  it("a configured rateLimitMaxAttempts changes how many failures it takes to lock out", () => {
    setConfigValue(getDb(), "rateLimitMaxAttempts", "2");
    const key = "10.0.0.1-e";
    expect(isLockedOut(key)).toBe(false);
    recordFailure(key);
    expect(isLockedOut(key)).toBe(false);
    recordFailure(key); // 2nd failure, now locked out at the configured threshold
    expect(isLockedOut(key)).toBe(true);
  });

  // `failCount >= NaN` is never true, so a garbage value would silently
  // disable the lockout entirely — failing open on the one control that stops
  // a keypad brute force.
  it("falls back to the default max attempts when the configured value isn't a number, instead of never locking out", () => {
    setConfigValue(getDb(), "rateLimitMaxAttempts", "not-a-number");
    const key = "10.0.0.1-nan-attempts";
    for (let i = 0; i < 5; i++) recordFailure(key);
    expect(isLockedOut(key)).toBe(true);
  });

  it("falls back to the default lockout length when the configured value isn't a number", () => {
    setConfigValue(getDb(), "rateLimitLockoutSec", "abc");
    const key = "10.0.0.1-nan-lockout";
    for (let i = 0; i < 5; i++) recordFailure(key);
    expect(isLockedOut(key)).toBe(true);
    // The 5-minute default, not an instantly-expiring NaN window.
    vi.advanceTimersByTime(299_000);
    expect(isLockedOut(key)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(isLockedOut(key)).toBe(false);
  });

  it("falls back to the default window when the configured value isn't a number", () => {
    setConfigValue(getDb(), "rateLimitWindowSec", "");
    const key = "10.0.0.1-nan-window";
    for (let i = 0; i < 5; i++) recordFailure(key);
    expect(isLockedOut(key)).toBe(true);
  });

  it("a configured rateLimitLockoutSec changes how long the lockout lasts", () => {
    setConfigValue(getDb(), "rateLimitMaxAttempts", "2");
    setConfigValue(getDb(), "rateLimitLockoutSec", "60");
    const key = "10.0.0.1-f";
    recordFailure(key);
    recordFailure(key);
    expect(isLockedOut(key)).toBe(true);
    vi.advanceTimersByTime(59_000);
    expect(isLockedOut(key)).toBe(true);
    vi.advanceTimersByTime(2_000);
    expect(isLockedOut(key)).toBe(false);
  });

  it("forgets failures that aged out of the window, even if the window is lengthened later", () => {
    const key = "10.0.0.1-window";
    setConfigValue(getDb(), "rateLimitWindowSec", "3");
    for (let i = 0; i < 4; i++) recordFailure(key);
    vi.advanceTimersByTime(4_000);
    expect(isLockedOut(key)).toBe(false); // the read drops the aged-out bucket
    setConfigValue(getDb(), "rateLimitWindowSec", "60");
    recordFailure(key);
    expect(isLockedOut(key)).toBe(false); // one failure, not five
  });

  it("sweeps expired buckets once many distinct keys pile up, so a rotating X-Forwarded-For can't grow the map forever", () => {
    for (let i = 0; i < 1_000; i++) recordFailure(`spoof-${i}`);
    expect(globalThis.__uapRateLimitBuckets!.size).toBe(1_000);
    vi.advanceTimersByTime(6 * 60 * 1000); // past the 5 minute window
    recordFailure("one-more");
    expect(globalThis.__uapRateLimitBuckets!.size).toBe(1);
  });
});
