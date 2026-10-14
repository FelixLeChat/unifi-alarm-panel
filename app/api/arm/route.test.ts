import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { getEngine } from "@/lib/engine";
import { createPin } from "@/lib/services/pins";
import { upsertSensor } from "@/lib/services/sensors";
import { POST } from "./route";

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  closeDb();
  delete globalThis.__uapEngine;
});

afterEach(() => {
  closeDb();
  delete globalThis.__uapEngine;
});

function armReq(pin: unknown, forwardedFor: string, force?: boolean): Request {
  return new Request("http://localhost/api/arm", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": forwardedFor },
    body: JSON.stringify(force === undefined ? { pin } : { pin, force }),
  });
}

describe("arm route", () => {
  it("rejects a body that isn't exactly 4 digits", async () => {
    const res = await POST(armReq("12", "10.20.30.1"));
    expect(res.status).toBe(400);
  });

  it("arms the system with a correct PIN", async () => {
    await createPin(getDb(), "Alex", "1234");
    const res = await POST(armReq("1234", "10.20.30.2"));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(getEngine().getStatus().state).not.toBe("DISARMED");
  });

  it("rejects an incorrect PIN and leaves the system disarmed", async () => {
    await createPin(getDb(), "Alex", "1234");
    const res = await POST(armReq("9999", "10.20.30.3"));
    expect(res.status).toBe(401);
    expect((await res.json()).ok).toBe(false);
    expect(getEngine().getStatus().state).toBe("DISARMED");
  });

  it("locks out after 5 invalid PINs from the same source, returning 429", async () => {
    await createPin(getDb(), "Alex", "1234");
    const key = "10.20.30.4";
    for (let i = 0; i < 5; i++) await POST(armReq("9999", key));
    const res = await POST(armReq("9999", key));
    expect(res.status).toBe(429);
  });

  it("returns 409 (distinct from a wrong-PIN 401) with the open sensor list while a door is open", async () => {
    await createPin(getDb(), "Alex", "1234");
    upsertSensor(getDb(), "front-door", "Front Door", "instant", null, null, "door");
    getDb().prepare("UPDATE sensors SET current_state = 'open' WHERE unifi_id = ?").run("front-door");

    const res = await POST(armReq("1234", "10.20.30.5"));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; reason: string; openSensors: { name: string }[] };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("sensors_open");
    expect(body.openSensors).toEqual([{ id: expect.any(Number), name: "Front Door" }]);
    expect(getEngine().getStatus().state).toBe("DISARMED");
  });

  it("force:true arms anyway despite the open door", async () => {
    await createPin(getDb(), "Alex", "1234");
    upsertSensor(getDb(), "front-door", "Front Door", "instant", null, null, "door");
    getDb().prepare("UPDATE sensors SET current_state = 'open' WHERE unifi_id = ?").run("front-door");

    const res = await POST(armReq("1234", "10.20.30.6", true));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(getEngine().getStatus().state).not.toBe("DISARMED");
  });
});
