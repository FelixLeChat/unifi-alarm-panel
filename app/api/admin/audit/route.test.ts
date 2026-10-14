import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { recordAudit } from "@/lib/services/audit";
import { GET } from "./route";

const ADMIN_TOKEN = "test-admin-token";

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  closeDb();
});

afterEach(() => {
  closeDb();
});

describe("admin audit route", () => {
  it("rejects requests without the admin token", async () => {
    const res = await GET(new Request("http://localhost/api/admin/audit"));
    expect(res.status).toBe(401);
  });

  it("returns the audit log, most recent first, respecting limit", async () => {
    const db = getDb();
    for (let i = 0; i < 5; i++) recordAudit(db, `event_${i}`);

    const res = await GET(
      new Request("http://localhost/api/admin/audit?limit=2", {
        headers: { "x-admin-token": ADMIN_TOKEN },
      }),
    );
    const { audit } = (await res.json()) as { audit: { event: string }[] };
    expect(audit).toHaveLength(2);
    expect(audit[0].event).toBe("event_4");
  });

  it("filters to one sensor's own trip history via sensorId", async () => {
    const db = getDb();
    recordAudit(db, "sensor_trip_while_disarmed", { detail: { sensorId: "front-door" } });
    recordAudit(db, "sensor_trip_while_disarmed", { detail: { sensorId: "back-door" } });
    recordAudit(db, "alarm_instant", { detail: { sensorId: "front-door" } });
    recordAudit(db, "config_updated", { detail: {} });

    const res = await GET(
      new Request("http://localhost/api/admin/audit?sensorId=front-door", {
        headers: { "x-admin-token": ADMIN_TOKEN },
      }),
    );
    const { audit } = (await res.json()) as { audit: { event: string }[] };
    expect(audit).toHaveLength(2);
    expect(audit.map((a) => a.event)).toEqual(["alarm_instant", "sensor_trip_while_disarmed"]);
  });
});
