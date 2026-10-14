import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db";
import { AlarmEngine } from "@/lib/engine";
import type { Notifier } from "./notifiers";
import { createPin } from "./pins";
import { handleSensorWebhook } from "./sensor-webhook";
import { listAudit } from "./audit";
import { setConfigValue } from "./config";
import { upsertSensor } from "./sensors";

let db: Database.Database;
let notifier: Notifier;
let sent: { kind: string; sensorId?: string }[];

beforeEach(() => {
  vi.useFakeTimers();
  db = createDb(":memory:");
  sent = [];
  notifier = {
    send: vi.fn(async (alert) => {
      sent.push(alert);
    }),
  };
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

describe("handleSensorWebhook", () => {
  it("while ARMED, a trip from a default-mode sensor waits out the entry delay before alerting", async () => {
    await createPin(db, "Alex", "1234");
    const engine = new AlarmEngine(db, notifier);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(30_000); // past the default exit delay -> ARMED

    const result = handleSensorWebhook(db, engine, JSON.stringify({ sensorId: "back-door", eventType: "open" }));

    expect(result.status).toBe(200);
    expect(engine.getStatus().state).toBe("ENTRY_DELAY");
    expect(sent).toEqual([]);

    await vi.advanceTimersByTimeAsync(30_000); // default entry delay runs out
    expect(engine.getStatus().state).toBe("ALARM");
    expect(sent).toContainEqual(expect.objectContaining({ kind: "ALARM", sensorId: "back-door" }));
  });

  it("while DISARMED, a sensor trip is only audited — no alert, no alarm", () => {
    const engine = new AlarmEngine(db, notifier);

    const result = handleSensorWebhook(db, engine, JSON.stringify({ sensorId: "back-door", eventType: "open" }));

    expect(result.status).toBe(200);
    expect(engine.getStatus().state).toBe("DISARMED");
    expect(sent).toEqual([]);
    const audit = listAudit(db, 10);
    expect(audit.some((a) => a.event === "sensor_trip_while_disarmed")).toBe(true);
  });

  it("registers a never-seen-before sensor with a safe default mode instead of dropping it", () => {
    const engine = new AlarmEngine(db, notifier);
    handleSensorWebhook(db, engine, JSON.stringify({ sensorId: "brand-new-sensor", eventType: "open" }));

    const row = db.prepare("SELECT mode FROM sensors WHERE unifi_id = ?").get("brand-new-sensor") as
      | { mode: string }
      | undefined;
    expect(row?.mode).toBe("delayed");
  });

  it("tolerates an unparseable body without crashing, and records the raw payload for debugging", () => {
    const engine = new AlarmEngine(db, notifier);
    const result = handleSensorWebhook(db, engine, "not json at all {{{");

    expect(result.status).toBe(200);
    expect(result.body.ok).toBe(true);
    const audit = listAudit(db, 10);
    const row = audit.find((a) => a.event === "webhook_unparseable");
    expect(row).toBeDefined();
    expect((row?.detail as { raw: string } | null)?.raw).toBe("not json at all {{{");
  });

  it("tolerates a well-formed but unrecognized JSON shape", () => {
    const engine = new AlarmEngine(db, notifier);
    const result = handleSensorWebhook(db, engine, JSON.stringify({ totallyDifferent: "shape" }));

    expect(result.status).toBe(200);
    expect(engine.getStatus().state).toBe("DISARMED");
  });

  it("updates a door sensor's current_state when eventType matches the configured sensorOpenEventTypes list", () => {
    setConfigValue(db, "sensorOpenEventTypes", "door_open");
    upsertSensor(db, "front-door", "Front Door", "instant", null, null, "door");
    const engine = new AlarmEngine(db, notifier);

    handleSensorWebhook(db, engine, JSON.stringify({ sensorId: "front-door", eventType: "door_open" }));

    const row = db.prepare("SELECT current_state FROM sensors WHERE unifi_id = ?").get("front-door") as {
      current_state: string | null;
    };
    expect(row.current_state).toBe("open");
  });
});
