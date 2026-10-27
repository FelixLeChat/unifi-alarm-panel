import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { recordAudit } from "@/lib/services/audit";
import { upsertSensor } from "@/lib/services/sensors";
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

function adminReq(url: string): Request {
  return new Request(`http://localhost${url}`, { headers: { "x-admin-token": ADMIN_TOKEN } });
}

describe("admin events route", () => {
  it("rejects requests without the admin token", async () => {
    const res = await GET(new Request("http://localhost/api/admin/events"));
    expect(res.status).toBe(401);
  });

  it("joins each incident's sensor against the sensors table for name/camera/rtsp", async () => {
    const db = getDb();
    upsertSensor(db, "front-door", "Front Door", "instant", "cam-1", "rtsps://cam.local/1");
    recordAudit(db, "alarm_instant", { detail: { sensorId: "front-door" } });

    const res = await GET(adminReq("/api/admin/events"));
    expect(res.status).toBe(200);
    const { incidents } = (await res.json()) as {
      incidents: {
        sensors: { sensorId: string; sensorName: string; cameraId: string | null; rtspUrl: string | null }[];
      }[];
    };
    expect(incidents).toHaveLength(1);
    expect(incidents[0].sensors).toEqual([
      {
        sensorId: "front-door",
        sensorName: "Front Door",
        cameraId: "cam-1",
        rtspUrl: "rtsps://cam.local/1",
        tripCount: 1,
        firstTs: expect.any(String),
        lastTs: expect.any(String),
      },
    ]);
  });

  it("falls back to the raw sensorId when no matching sensor row exists", async () => {
    const db = getDb();
    recordAudit(db, "alarm_instant", { detail: { sensorId: "unknown-sensor" } });

    const res = await GET(adminReq("/api/admin/events"));
    const { incidents } = (await res.json()) as {
      incidents: { sensors: { sensorName: string; cameraId: string | null }[] }[];
    };
    expect(incidents[0].sensors).toEqual([expect.objectContaining({ sensorName: "unknown-sensor", cameraId: null })]);
  });

  it("clamps limit to the documented maximum", async () => {
    const db = getDb();
    // 150 incidents, well past MAX_LIMIT (100) and DEFAULT_LIMIT (30) — each
    // one is its own incident (20 min apart, well outside the 5-min window).
    for (let i = 0; i < 150; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, i * 20)).toISOString();
      db.prepare("INSERT INTO audit (ts, event, detail_json) VALUES (?, ?, ?)").run(
        ts,
        "alarm_instant",
        JSON.stringify({ sensorId: `s-${i}` }),
      );
    }

    const res = await GET(adminReq("/api/admin/events?limit=9999"));
    const { incidents } = (await res.json()) as { incidents: unknown[] };
    expect(incidents.length).toBeLessThanOrEqual(100);
  });

  it("defaults to 30 when limit is omitted or invalid", async () => {
    const db = getDb();
    for (let i = 0; i < 40; i++) {
      const ts = new Date(Date.UTC(2026, 0, 1, 0, i * 20)).toISOString();
      db.prepare("INSERT INTO audit (ts, event, detail_json) VALUES (?, ?, ?)").run(
        ts,
        "alarm_instant",
        JSON.stringify({ sensorId: `s-${i}` }),
      );
    }

    const res = await GET(adminReq("/api/admin/events?limit=not-a-number"));
    const { incidents } = (await res.json()) as { incidents: unknown[] };
    expect(incidents).toHaveLength(30);
  });
});
