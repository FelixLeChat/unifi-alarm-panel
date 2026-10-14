import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { listAudit } from "@/lib/services/audit";
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

function armReq(body?: unknown): Request {
  return new Request("http://localhost/api/panel/arm", {
    method: "POST",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("panel arm route", () => {
  it("arms with no PIN and no body, and attributes the panel in the audit log", async () => {
    const res = await POST(armReq());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);

    const audit = listAudit(getDb(), 10);
    const row = audit.find((a) => a.event === "arming_started");
    expect(row?.actorLabel).toBe("Panel");
  });

  it("returns 409 with the open sensor list while a door is open, and doesn't arm", async () => {
    upsertSensor(getDb(), "front-door", "Front Door", "instant", null, null, "door");
    getDb().prepare("UPDATE sensors SET current_state = 'open' WHERE unifi_id = ?").run("front-door");

    const res = await POST(armReq());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; reason: string; openSensors: { name: string }[] };
    expect(body.ok).toBe(false);
    expect(body.reason).toBe("sensors_open");
    expect(body.openSensors).toEqual([{ id: expect.any(Number), name: "Front Door" }]);
  });

  it("force:true arms anyway despite the open door", async () => {
    upsertSensor(getDb(), "front-door", "Front Door", "instant", null, null, "door");
    getDb().prepare("UPDATE sensors SET current_state = 'open' WHERE unifi_id = ?").run("front-door");

    const res = await POST(armReq({ force: true }));
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });
});
