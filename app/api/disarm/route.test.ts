import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { listAudit } from "@/lib/services/audit";
import { createPin } from "@/lib/services/pins";
import { POST } from "./route";

beforeEach(() => {
  delete globalThis.__uapRateLimitBuckets;
  process.env.DATABASE_PATH = ":memory:";
  closeDb();
  delete globalThis.__uapEngine;
});

afterEach(() => {
  closeDb();
  delete globalThis.__uapEngine;
});

function disarmReq(pin: unknown, forwardedFor: string): Request {
  return new Request("http://localhost/api/disarm", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify({ pin }),
  });
}

describe("disarm route", () => {
  it("locks out after 5 wrong PINs even when X-Forwarded-For changes on every request", async () => {
    await createPin(getDb(), "Alex", "1234");
    for (let i = 0; i < 5; i++) {
      await POST(disarmReq("0000", `10.66.0.${i}`));
    }
    // The right PIN from a fresh "source" is still refused: the lockout isn't per caller-supplied header.
    const res = await POST(disarmReq("1234", "10.66.0.99"));
    expect(res.status).toBe(429);
  });

  it("rejects a body that isn't exactly 4 digits", async () => {
    const res = await POST(disarmReq("123456", "10.20.40.1"));
    expect(res.status).toBe(400);
  });

  it("accepts a correct PIN, attributing the audit entry to its label", async () => {
    await createPin(getDb(), "Alex", "1234");
    const res = await POST(disarmReq("1234", "10.20.40.2"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);

    // Already disarmed by default, so this is the no-op branch — see
    // lib/state/machine.ts's handleDisarm() — but it still proves the route
    // wired PIN verification through to the engine correctly.
    const row = listAudit(getDb(), 10).find((a) => a.event === "disarm_while_disarmed");
    expect(row?.actorLabel).toBe("Alex");
  });

  it("rejects an incorrect PIN", async () => {
    await createPin(getDb(), "Alex", "1234");
    const res = await POST(disarmReq("9999", "10.20.40.3"));
    expect(res.status).toBe(401);
    expect((await res.json()).ok).toBe(false);
  });

  it("locks out after 5 invalid PINs from the same source, returning 429", async () => {
    await createPin(getDb(), "Alex", "1234");
    const key = "10.20.40.4";
    for (let i = 0; i < 5; i++) await POST(disarmReq("9999", key));
    const res = await POST(disarmReq("9999", key));
    expect(res.status).toBe(429);
  });
});
