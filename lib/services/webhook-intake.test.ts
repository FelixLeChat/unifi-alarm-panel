import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db";
import { setConfigValue } from "./config";
import { getLastWebhookAgeSec, getRecentRawPayloads, hasEverReceivedWebhook, parseSensorWebhook, recordRawPayload } from "./webhook-intake";

let db: Database.Database;

beforeEach(() => {
  db = createDb(":memory:");
  delete globalThis.__uapWebhookIntake;
});

afterEach(() => {
  db.close();
});

describe("parseSensorWebhook", () => {
  it("reads sensorId/eventType from the default top-level fields", () => {
    const result = parseSensorWebhook(db, { sensorId: "up-sense-1", eventType: "open" });
    expect(result).toEqual({ sensorId: "up-sense-1", eventType: "open" });
  });

  it("reads from configured dotted paths once the real UniFi shape is known", () => {
    setConfigValue(db, "webhookSensorIdPath", "sensor.id");
    setConfigValue(db, "webhookEventTypePath", "trigger.state");
    const result = parseSensorWebhook(db, { sensor: { id: "front-door" }, trigger: { state: "open" } });
    expect(result).toEqual({ sensorId: "front-door", eventType: "open" });
  });

  it("returns null when the sensor id can't be found — never throws", () => {
    expect(parseSensorWebhook(db, { somethingElse: true })).toBeNull();
    expect(parseSensorWebhook(db, null)).toBeNull();
    expect(parseSensorWebhook(db, "not even an object")).toBeNull();
    expect(parseSensorWebhook(db, 42)).toBeNull();
  });

  it("tolerates a missing eventType", () => {
    const result = parseSensorWebhook(db, { sensorId: "s1" });
    expect(result).toEqual({ sensorId: "s1", eventType: undefined });
  });
});

describe("raw payload ring buffer", () => {
  it("keeps only the most recent N payloads", () => {
    for (let i = 0; i < 30; i++) {
      recordRawPayload(JSON.stringify({ i }));
    }
    const recent = getRecentRawPayloads();
    expect(recent.length).toBeLessThanOrEqual(20);
    expect(recent[recent.length - 1].raw).toBe(JSON.stringify({ i: 29 }));
  });
});

describe("getLastWebhookAgeSec", () => {
  // Silence since boot counts as silence: a feed that was already dead when
  // the process started used to report null here, which every caller read as
  // "nothing wrong" (see getLastWebhookAgeSec's own comment).
  it("measures from process start until a payload has been recorded", () => {
    expect(getLastWebhookAgeSec()).toBe(0);
    expect(hasEverReceivedWebhook()).toBe(false);
  });

  it("reflects a just-recorded payload as ~0 seconds old", () => {
    recordRawPayload(JSON.stringify({ sensorId: "s1" }));
    expect(getLastWebhookAgeSec()).toBe(0);
    expect(hasEverReceivedWebhook()).toBe(true);
  });

  /**
   * /api/hooks/sensor's route handler (the writer) and /api/health /
   * checkConnectivity() (the readers) each compile into their own bundle —
   * a plain module-scoped variable gave each its own copy, so a webhook
   * recorded by the route handler was invisible everywhere else, and
   * lastWebhookAgeSec stayed stuck at null in production regardless of
   * whether webhooks were actually arriving. Simulate that split with
   * vi.resetModules() between the write and the read to prove the
   * globalThis-backed state survives it.
   */
  it("survives a fresh module import, simulating a separate route-handler bundle", async () => {
    const writer = await import("./webhook-intake");
    writer.recordRawPayload(JSON.stringify({ sensorId: "s1" }));

    vi.resetModules();
    const reader = await import("./webhook-intake");
    expect(reader.getLastWebhookAgeSec()).not.toBeNull();
  });
});
