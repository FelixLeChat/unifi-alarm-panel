import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/lib/db";
import { recordAudit } from "./audit";
import { setConfigValue } from "./config";
import { deleteSensor, getSensor, listOpenGatingSensors, listSensors, resolveSensorMode, updateSensorState, upsertSensor } from "./sensors";

let db: Database.Database;

beforeEach(() => {
  db = createDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("upsertSensor / getSensor / listSensors", () => {
  it("creates a new sensor, defaulting name to the unifiId when none is given", () => {
    upsertSensor(db, "front-door", undefined, "delayed");
    expect(getSensor(db, "front-door")).toEqual({
      id: expect.any(Number),
      unifiId: "front-door",
      name: "front-door",
      mode: "delayed",
      cameraId: null,
      rtspUrl: null,
      sensorType: null,
      lastTrippedAt: null,
      tripCount7d: 0,
      tripCount24h: 0,
      currentState: null,
    });
  });

  it("updates an existing sensor in place rather than duplicating it", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed");
    upsertSensor(db, "front-door", "Front Door", "instant", "cam-1");

    expect(listSensors(db)).toHaveLength(1);
    expect(getSensor(db, "front-door")).toMatchObject({ mode: "instant", cameraId: "cam-1" });
  });

  it("leaves an existing cameraId alone when the update omits it", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed", "cam-1");
    upsertSensor(db, "front-door", "Front Door", "instant");
    expect(getSensor(db, "front-door")?.cameraId).toBe("cam-1");
  });

  it("clears cameraId when explicitly passed null", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed", "cam-1");
    upsertSensor(db, "front-door", "Front Door", "instant", null);
    expect(getSensor(db, "front-door")?.cameraId).toBeNull();
  });

  it("leaves an existing rtspUrl alone when the update omits it", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed", "cam-1", "rtsps://192.168.1.1:7441/abc");
    upsertSensor(db, "front-door", "Front Door", "instant", "cam-1");
    expect(getSensor(db, "front-door")?.rtspUrl).toBe("rtsps://192.168.1.1:7441/abc");
  });

  it("clears rtspUrl when explicitly passed null", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed", "cam-1", "rtsps://192.168.1.1:7441/abc");
    upsertSensor(db, "front-door", "Front Door", "instant", "cam-1", null);
    expect(getSensor(db, "front-door")?.rtspUrl).toBeNull();
  });

  it("leaves an existing sensorType alone when the update omits it", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed", "cam-1", null, "door");
    upsertSensor(db, "front-door", "Front Door", "instant", "cam-1");
    expect(getSensor(db, "front-door")?.sensorType).toBe("door");
  });

  it("clears sensorType when explicitly passed null", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed", "cam-1", null, "door");
    upsertSensor(db, "front-door", "Front Door", "instant", "cam-1", null, null);
    expect(getSensor(db, "front-door")?.sensorType).toBeNull();
  });

  it("returns null for a sensor that doesn't exist", () => {
    expect(getSensor(db, "nope")).toBeNull();
  });
});

describe("resolveSensorMode", () => {
  it("auto-registers an unknown sensor with the default mode", () => {
    const mode = resolveSensorMode(db, "new-sensor");
    expect(mode).toBe("delayed");
    expect(getSensor(db, "new-sensor")).toMatchObject({ unifiId: "new-sensor", name: "new-sensor", mode: "delayed" });
  });

  it("returns the existing mode for an already-known sensor, without touching it", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed", "cam-1");
    const mode = resolveSensorMode(db, "front-door");
    expect(mode).toBe("delayed");
    expect(getSensor(db, "front-door")).toMatchObject({ name: "Front Door", cameraId: "cam-1" });
  });

  it("leaves cameraId unmapped for any eventType when cameraTriggerEventTypes isn't configured (default, no behavior change)", () => {
    resolveSensorMode(db, "new-sensor", "open");
    expect(getSensor(db, "new-sensor")?.cameraId).toBeNull();
    resolveSensorMode(db, "28704E13C8E9", "motion");
    expect(getSensor(db, "28704E13C8E9")?.cameraId).toBeNull();
  });

  it("self-maps cameraId to the device's own id when eventType matches the configured cameraTriggerEventTypes list", () => {
    setConfigValue(db, "cameraTriggerEventTypes", "motion");
    resolveSensorMode(db, "28704E13C8E9", "motion");
    expect(getSensor(db, "28704E13C8E9")?.cameraId).toBe("28704E13C8E9");
  });

  it("supports a comma-separated list of configured event types", () => {
    setConfigValue(db, "cameraTriggerEventTypes", "motion, ring");
    resolveSensorMode(db, "cam-a", "motion");
    resolveSensorMode(db, "cam-b", "ring");
    expect(getSensor(db, "cam-a")?.cameraId).toBe("cam-a");
    expect(getSensor(db, "cam-b")?.cameraId).toBe("cam-b");
  });

  it("leaves cameraId unmapped when eventType doesn't match the configured list", () => {
    setConfigValue(db, "cameraTriggerEventTypes", "motion");
    resolveSensorMode(db, "up-sense-1", "sensor_door_opened");
    expect(getSensor(db, "up-sense-1")?.cameraId).toBeNull();
  });

  it("does not re-classify an already-known sensor even if a later trip matches the configured list", () => {
    setConfigValue(db, "cameraTriggerEventTypes", "motion");
    upsertSensor(db, "front-door", "Front Door", "delayed", null);
    resolveSensorMode(db, "front-door", "motion");
    expect(getSensor(db, "front-door")?.cameraId).toBeNull();
  });
});

describe("lastTrippedAt", () => {
  it("is null for a sensor with no trip history", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed");
    expect(getSensor(db, "front-door")?.lastTrippedAt).toBeNull();
  });

  it("reflects the most recent trip-related audit event for that sensor", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed");
    recordAudit(db, "sensor_trip_while_disarmed", { detail: { sensorId: "front-door", mode: "delayed" } });
    recordAudit(db, "alarm_instant", { detail: { sensorId: "front-door" } });

    const lastTrippedAt = getSensor(db, "front-door")?.lastTrippedAt;
    expect(lastTrippedAt).not.toBeNull();

    // Also surfaced through listSensors, not just getSensor.
    expect(listSensors(db).find((s) => s.unifiId === "front-door")?.lastTrippedAt).toBe(lastTrippedAt);
  });

  it("ignores audit events for a different sensor", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed");
    recordAudit(db, "sensor_trip_while_disarmed", { detail: { sensorId: "back-door" } });
    expect(getSensor(db, "front-door")?.lastTrippedAt).toBeNull();
  });

  it("ignores unrelated audit events that happen to carry a similarly-shaped detail object", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed");
    recordAudit(db, "config_updated", { detail: { configKeys: [], sensorIds: ["front-door"] } });
    expect(getSensor(db, "front-door")?.lastTrippedAt).toBeNull();
  });
});

describe("tripCount7d", () => {
  it("counts only this sensor's trips inside the window", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed");
    upsertSensor(db, "back-door", "Back Door", "delayed");
    recordAudit(db, "sensor_trip_while_disarmed", { detail: { sensorId: "front-door" } });
    recordAudit(db, "alarm_instant", { detail: { sensorId: "front-door" } });
    recordAudit(db, "sensor_trip_while_disarmed", { detail: { sensorId: "back-door" } });

    expect(getSensor(db, "front-door")?.tripCount7d).toBe(2);
    expect(getSensor(db, "back-door")?.tripCount7d).toBe(1);
  });

  /**
   * The cutoff compares against `ts` as it is actually stored — the
   * schema's strftime('%Y-%m-%dT%H:%M:%fZ') ISO form, not SQLite's default
   * space-separated datetime(), which would compare wrong at the boundary
   * (the 'T' sorts above a space) and quietly count an out-of-window row.
   */
  it("excludes a trip older than the window", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed");
    db.prepare(
      "INSERT INTO audit (ts, event, detail_json) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now','-8 days'), 'sensor_trip_while_disarmed', ?)",
    ).run(JSON.stringify({ sensorId: "front-door" }));
    db.prepare(
      "INSERT INTO audit (ts, event, detail_json) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 days'), 'sensor_trip_while_disarmed', ?)",
    ).run(JSON.stringify({ sensorId: "front-door" }));

    expect(getSensor(db, "front-door")?.tripCount7d).toBe(1);
    expect(getSensor(db, "front-door")?.lastTrippedAt).not.toBeNull();
  });
});

describe("tripCount24h", () => {
  it("counts only this sensor's trips inside the last day, separately from the 7-day figure", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed");
    upsertSensor(db, "back-door", "Back Door", "delayed");
    recordAudit(db, "sensor_trip_while_disarmed", { detail: { sensorId: "front-door" } });
    recordAudit(db, "sensor_trip_while_disarmed", { detail: { sensorId: "back-door" } });
    db.prepare(
      "INSERT INTO audit (ts, event, detail_json) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now','-3 days'), 'sensor_trip_while_disarmed', ?)",
    ).run(JSON.stringify({ sensorId: "front-door" }));

    // Two trips in the last 7 days, only one of them inside the last 24h.
    expect(getSensor(db, "front-door")?.tripCount7d).toBe(2);
    expect(getSensor(db, "front-door")?.tripCount24h).toBe(1);
    expect(getSensor(db, "back-door")?.tripCount24h).toBe(1);
  });

  it("excludes a trip older than 24h even though it's still within the 7-day window", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed");
    db.prepare(
      "INSERT INTO audit (ts, event, detail_json) VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now','-2 days'), 'sensor_trip_while_disarmed', ?)",
    ).run(JSON.stringify({ sensorId: "front-door" }));

    expect(getSensor(db, "front-door")?.tripCount7d).toBe(1);
    expect(getSensor(db, "front-door")?.tripCount24h).toBe(0);
  });
});

function currentState(unifiId: string): string | null {
  const row = db.prepare("SELECT current_state FROM sensors WHERE unifi_id = ?").get(unifiId) as
    | { current_state: string | null }
    | undefined;
  return row?.current_state ?? null;
}

describe("updateSensorState", () => {
  it("leaves current_state untouched for any eventType when sensorOpenEventTypes/sensorClosedEventTypes aren't configured (default, no behavior change)", () => {
    upsertSensor(db, "front-door", "Front Door", "instant", null, null, "door");
    updateSensorState(db, "front-door", "open");
    expect(currentState("front-door")).toBeNull();
  });

  it("sets current_state to open when eventType matches the configured sensorOpenEventTypes list", () => {
    setConfigValue(db, "sensorOpenEventTypes", "door_open");
    upsertSensor(db, "front-door", "Front Door", "instant", null, null, "door");
    updateSensorState(db, "front-door", "door_open");
    expect(currentState("front-door")).toBe("open");
  });

  it("surfaces the updated state through getSensor/listSensors, not just the raw column", () => {
    setConfigValue(db, "sensorOpenEventTypes", "door_open");
    upsertSensor(db, "front-door", "Front Door", "instant", null, null, "door");
    updateSensorState(db, "front-door", "door_open");
    expect(getSensor(db, "front-door")?.currentState).toBe("open");
    expect(listSensors(db).find((s) => s.unifiId === "front-door")?.currentState).toBe("open");
  });

  it("sets current_state to closed when eventType matches the configured sensorClosedEventTypes list", () => {
    setConfigValue(db, "sensorOpenEventTypes", "door_open");
    setConfigValue(db, "sensorClosedEventTypes", "door_close");
    upsertSensor(db, "front-door", "Front Door", "instant", null, null, "door");
    updateSensorState(db, "front-door", "door_open");
    updateSensorState(db, "front-door", "door_close");
    expect(currentState("front-door")).toBe("closed");
  });

  it("leaves current_state untouched when eventType doesn't match either configured list", () => {
    setConfigValue(db, "sensorOpenEventTypes", "door_open");
    setConfigValue(db, "sensorClosedEventTypes", "door_close");
    upsertSensor(db, "front-door", "Front Door", "instant", null, null, "door");
    updateSensorState(db, "front-door", "tamper");
    expect(currentState("front-door")).toBeNull();
  });
});

describe("listOpenGatingSensors", () => {
  it("returns a door sensor that is currently open", () => {
    setConfigValue(db, "sensorOpenEventTypes", "door_open");
    upsertSensor(db, "front-door", "Front Door", "instant", null, null, "door");
    updateSensorState(db, "front-door", "door_open");
    expect(listOpenGatingSensors(db)).toEqual([{ id: expect.any(Number), name: "Front Door" }]);
  });

  it("excludes an open sensor whose mode is 'ignore', even if it's a door", () => {
    setConfigValue(db, "sensorOpenEventTypes", "door_open");
    upsertSensor(db, "front-door", "Front Door", "ignore", null, null, "door");
    updateSensorState(db, "front-door", "door_open");
    expect(listOpenGatingSensors(db)).toEqual([]);
  });

  it("excludes an open sensor that isn't classified as a door", () => {
    setConfigValue(db, "sensorOpenEventTypes", "door_open");
    upsertSensor(db, "motion-1", "Motion", "instant", null, null, "motion");
    updateSensorState(db, "motion-1", "door_open");
    expect(listOpenGatingSensors(db)).toEqual([]);
  });

  it("excludes a door sensor that is closed", () => {
    setConfigValue(db, "sensorOpenEventTypes", "door_open");
    setConfigValue(db, "sensorClosedEventTypes", "door_close");
    upsertSensor(db, "front-door", "Front Door", "instant", null, null, "door");
    updateSensorState(db, "front-door", "door_close");
    expect(listOpenGatingSensors(db)).toEqual([]);
  });
});

describe("deleteSensor", () => {
  it("removes the sensor row", () => {
    upsertSensor(db, "front-door", "Front Door", "delayed");
    deleteSensor(db, "front-door");
    expect(getSensor(db, "front-door")).toBeNull();
    expect(listSensors(db)).toHaveLength(0);
  });

  it("does nothing (no throw) when the sensor doesn't exist", () => {
    expect(() => deleteSensor(db, "never-existed")).not.toThrow();
  });

  it("a deleted sensor re-registers with the default mode if it trips again", () => {
    upsertSensor(db, "front-door", "Front Door", "ignore");
    deleteSensor(db, "front-door");
    const mode = resolveSensorMode(db, "front-door");
    expect(mode).toBe("delayed"); // back to the default, not the deleted "ignore" setting
  });
});
