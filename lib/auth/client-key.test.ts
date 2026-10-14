import { describe, expect, it } from "vitest";
import { clientKey } from "./client-key";

function req(forwardedFor?: string): Request {
  return new Request("http://localhost/api/disarm", {
    method: "POST",
    headers: forwardedFor === undefined ? {} : { "x-forwarded-for": forwardedFor },
  });
}

describe("clientKey", () => {
  it("uses the first X-Forwarded-For entry", () => {
    expect(clientKey(req("10.0.0.5, 10.0.0.1"))).toBe("10.0.0.5");
  });

  it("falls back to 'unknown' with no header", () => {
    expect(clientKey(req())).toBe("unknown");
  });

  // Every bucket key is "<namespace>:<source>" (lib/auth/admin.ts,
  // lib/auth/webhook.ts, AlarmEngine's pinBucket). This header is fully
  // caller-controlled, so a ":" left intact would let a caller write failures
  // into another guard's namespace. Reproduced against a real build: six wrong
  // PINs carrying "webhook:1.2.3.4" locked out the genuine UniFi sensor
  // webhook arriving from 1.2.3.4, silently dropping every sensor trip.
  it("neutralizes ':' so a caller can't aim failures at another guard's namespace", () => {
    expect(clientKey(req("webhook:1.2.3.4"))).toBe("webhook_1.2.3.4");
    expect(clientKey(req("admin:unknown"))).toBe("admin_unknown");
    expect(clientKey(req("pin:10.0.0.1"))).toBe("pin_10.0.0.1");
  });

  it("still produces a stable, distinct key for an IPv6 source", () => {
    // Mangled rather than preserved, which is fine: this value is only ever a
    // map key, never parsed back into an address.
    expect(clientKey(req("::1"))).toBe("__1");
    expect(clientKey(req("fe80::abcd"))).toBe("fe80__abcd");
    expect(clientKey(req("::1"))).toBe(clientKey(req("::1")));
    expect(clientKey(req("::1"))).not.toBe(clientKey(req("::2")));
  });

  it("caps an oversized header so one caller can't bloat the bucket map", () => {
    expect(clientKey(req("a".repeat(5000))).length).toBe(100);
  });
});
