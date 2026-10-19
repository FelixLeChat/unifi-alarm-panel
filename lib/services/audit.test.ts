import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/lib/db";
import { getLastArmDisarmEvent, listEventIncidents } from "./audit";

let db: Database.Database;

beforeEach(() => {
  db = createDb(":memory:");
});

afterEach(() => {
  db.close();
});

/** Inserts an audit row with an explicit timestamp, bypassing recordAudit's "now" default — needed to control gaps precisely for the rolling-window grouping tests. */
function insertAt(tsIso: string, event: string, detail?: unknown, actorLabel?: string): void {
  db.prepare("INSERT INTO audit (ts, actor_label, event, detail_json) VALUES (?, ?, ?, ?)").run(
    tsIso,
    actorLabel ?? null,
    event,
    detail !== undefined ? JSON.stringify(detail) : null,
  );
}

const T0 = new Date("2026-09-01T10:00:00.000Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000).toISOString();

describe("getLastArmDisarmEvent", () => {
  it("returns null when there's no arm/disarm history yet", () => {
    expect(getLastArmDisarmEvent(db)).toBeNull();
  });

  it("returns the most recent armed/disarmed event, with its actor", () => {
    insertAt(minutes(0), "arming_started");
    insertAt(minutes(0), "armed", undefined, "Alex");
    insertAt(minutes(5), "disarmed", undefined, "Jonathan");

    expect(getLastArmDisarmEvent(db)).toEqual({ event: "disarmed", ts: minutes(5), actorLabel: "Jonathan" });
  });

  it("isn't fooled by 50+ unrelated audit rows since the last arm/disarm — the bug this replaces derived it from a capped recent-events list", () => {
    insertAt(minutes(0), "armed", undefined, "Alex");
    for (let i = 1; i <= 60; i++) {
      insertAt(minutes(i), "sensor_trip_while_disarmed", { sensorId: "front-door" });
    }

    expect(getLastArmDisarmEvent(db)).toEqual({ event: "armed", ts: minutes(0), actorLabel: "Alex" });
  });
});

describe("listEventIncidents", () => {
  it("returns nothing when no alarm-relevant event has happened", () => {
    insertAt(minutes(0), "armed");
    insertAt(minutes(1), "disarmed");
    expect(listEventIncidents(db, 30)).toEqual([]);
  });

  it("builds one incident from a single alarm trip, unresolved", () => {
    insertAt(minutes(0), "alarm_instant", { sensorId: "front-door" });

    const incidents = listEventIncidents(db, 30);
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({
      startedAt: minutes(0),
      endedAt: minutes(0),
      triggeredAlarm: true,
      resolvedAt: null,
      resolvedBy: null,
      sensors: [{ sensorId: "front-door", tripCount: 1, firstTs: minutes(0), lastTs: minutes(0) }],
    });
  });

  it("attaches the next disarm as the resolution", () => {
    insertAt(minutes(0), "alarm_instant", { sensorId: "front-door" });
    insertAt(minutes(2), "disarmed", undefined, "Alex");

    const [incident] = listEventIncidents(db, 30);
    expect(incident.resolvedAt).toBe(minutes(2));
    expect(incident.resolvedBy).toBe("Alex");
  });

  it("groups repeated trips of the same sensor within the rolling window into one incident, summing trip count", () => {
    insertAt(minutes(0), "entry_delay_started", { sensorId: "front-door" });
    insertAt(minutes(1), "sensor_trip_during_entry_delay", { sensorId: "front-door" });
    insertAt(minutes(2), "alarm_instant_during_entry_delay", { sensorId: "front-door" });

    const incidents = listEventIncidents(db, 30);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].triggeredAlarm).toBe(true);
    expect(incidents[0].sensors).toEqual([
      { sensorId: "front-door", tripCount: 3, firstTs: minutes(0), lastTs: minutes(2) },
    ]);
  });

  it("groups trips from different sensors within the window into one multi-sensor incident", () => {
    insertAt(minutes(0), "entry_delay_started", { sensorId: "front-door" });
    insertAt(minutes(1), "sensor_trip_during_entry_delay", { sensorId: "hallway-motion" });

    const [incident] = listEventIncidents(db, 30);
    expect(incident.sensors.map((s) => s.sensorId).sort()).toEqual(["front-door", "hallway-motion"]);
  });

  it("is a rolling window measured from the last trip, not the first — a chain of trips spaced under 5 min apart stays one incident even if the total span exceeds 5 min", () => {
    insertAt(minutes(0), "alarm_instant", { sensorId: "hallway-motion" });
    insertAt(minutes(4), "sensor_trip_during_alarm", { sensorId: "hallway-motion" });
    insertAt(minutes(8), "sensor_trip_during_alarm", { sensorId: "hallway-motion" });

    const incidents = listEventIncidents(db, 30);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].sensors[0].tripCount).toBe(3);
  });

  it("splits into separate incidents once the gap since the last trip exceeds the window", () => {
    insertAt(minutes(0), "alarm_instant", { sensorId: "front-door" });
    insertAt(minutes(6), "alarm_instant", { sensorId: "front-door" });

    const incidents = listEventIncidents(db, 30);
    expect(incidents).toHaveLength(2);
  });

  it("ignores trips while disarmed and while arming (exit delay) — not alarm-relevant", () => {
    insertAt(minutes(0), "sensor_trip_while_disarmed", { sensorId: "front-door" });
    insertAt(minutes(1), "sensor_trip_while_arming", { sensorId: "front-door" });
    insertAt(minutes(2), "sensor_trip_ignored_mode", { sensorId: "front-door" });

    expect(listEventIncidents(db, 30)).toEqual([]);
  });

  it("does not resolve an incident with a disarm that already resolved a previous one", () => {
    insertAt(minutes(0), "alarm_instant", { sensorId: "front-door" });
    insertAt(minutes(1), "disarmed", undefined, "Alex");
    insertAt(minutes(20), "alarm_instant", { sensorId: "hallway-motion" });

    const incidents = listEventIncidents(db, 30);
    expect(incidents).toHaveLength(2);
    const [newest, oldest] = incidents;
    expect(oldest.resolvedBy).toBe("Alex");
    expect(newest.resolvedAt).toBeNull();
  });

  it("returns newest-first and respects limit", () => {
    for (let i = 0; i < 5; i++) {
      insertAt(minutes(i * 20), "alarm_instant", { sensorId: `sensor-${i}` });
      insertAt(minutes(i * 20 + 1), "disarmed");
    }

    const incidents = listEventIncidents(db, 2);
    expect(incidents).toHaveLength(2);
    expect(incidents[0].sensors[0].sensorId).toBe("sensor-4");
    expect(incidents[1].sensors[0].sensorId).toBe("sensor-3");
  });

  it("still creates an incident when the trigger event carries no sensorId, just with an empty sensor list", () => {
    insertAt(minutes(0), "alarm_entry_timeout");

    const incidents = listEventIncidents(db, 30);
    expect(incidents).toHaveLength(1);
    expect(incidents[0].sensors).toEqual([]);
  });
});
