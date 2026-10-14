import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db";
import { createPin } from "@/lib/services/pins";
import { listAudit } from "@/lib/services/audit";
import { setConfigValue } from "@/lib/services/config";
import { setSensorState, upsertSensor } from "@/lib/services/sensors";
import { saveSettings } from "@/lib/services/settings";
import type { Notifier, AlertPayload } from "@/lib/services/notifiers";
import type { ProtectClient, Snapshot } from "@/lib/services/protect-client";
import { AlarmEngine } from "./index";

let db: Database.Database;

beforeEach(() => {
  vi.useFakeTimers();
  // Rate-limit buckets live on globalThis, and every PIN attempt shares one bucket, so reset it per test.
  delete globalThis.__uapRateLimitBuckets;
  db = createDb(":memory:");
  setConfigValue(db, "exitDelaySec", "5");
  setConfigValue(db, "entryDelaySec", "10");
});

afterEach(() => {
  db.close();
  vi.useRealTimers();
});

function nullProtect(): ProtectClient {
  return {
    getSnapshot: async (): Promise<Snapshot | null> => null,
    getLiveViewUrl: () => "",
    listCameras: async () => [],
    triggerAlarmManagerWebhook: async () => true,
  };
}

function openDoorSensor(unifiId: string, name: string): void {
  upsertSensor(db, unifiId, name, "instant", null, null, "door");
  db.prepare("UPDATE sensors SET current_state = 'open' WHERE unifi_id = ?").run(unifiId);
}

describe("AlarmEngine", () => {
  it("boots DISARMED and persists it", () => {
    const engine = new AlarmEngine(db);
    expect(engine.getStatus().state).toBe("DISARMED");
    const row = db.prepare("SELECT name FROM alarm_state WHERE id = 1").get() as { name: string };
    expect(row.name).toBe("DISARMED");
  });

  it("restores prior state from the database on construction", () => {
    db.prepare("INSERT INTO alarm_state (id, name, since) VALUES (1, 'ARMED', ?)").run(
      new Date().toISOString(),
    );
    const engine = new AlarmEngine(db);
    expect(engine.getStatus().state).toBe("ARMED");
  });

  it("arm() with a valid PIN starts the exit delay, then flips to ARMED", async () => {
    await createPin(db, "Alex", "1234");
    const engine = new AlarmEngine(db);

    const result = await engine.arm("1234");
    expect(result.ok).toBe(true);
    expect(engine.getStatus().state).toBe("ARMING");
    expect(engine.getStatus().remainingSec).toBe(5);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.getStatus().state).toBe("ARMED");
  });

  it("arm() with an invalid PIN does nothing and is audited with the source", async () => {
    const engine = new AlarmEngine(db);
    const result = await engine.arm("0000", "10.0.0.5");
    expect(result.ok).toBe(false);
    expect(engine.getStatus().state).toBe("DISARMED");
    const audit = listAudit(db, 10);
    const row = audit.find((a) => a.event === "arm_failed_invalid_pin");
    expect(row).toBeDefined();
    expect((row?.detail as { source: string } | null)?.source).toBe("10.0.0.5");
  });

  it("armWithoutPin() arms with no PIN, attributed to the panel", async () => {
    const engine = new AlarmEngine(db);
    const result = engine.armWithoutPin("Panel");
    expect(result.ok).toBe(true);
    expect(engine.getStatus().state).toBe("ARMING");
    const audit = listAudit(db, 10);
    const row = audit.find((a) => a.event === "arming_started");
    expect(row?.actorLabel).toBe("Panel");
  });

  it("syncExternalArmState(true) arms from disarmed, attributed to UniFi by default", () => {
    const engine = new AlarmEngine(db);
    engine.syncExternalArmState(true);
    expect(engine.getStatus().state).toBe("ARMING");
    const audit = listAudit(db, 10);
    const row = audit.find((a) => a.event === "arming_started");
    expect(row?.actorLabel).toBe("UniFi");
  });

  it("syncExternalArmState(true) uses the short externalArmSyncDelaySec, not the normal exitDelaySec (5s from beforeEach)", async () => {
    setConfigValue(db, "externalArmSyncDelaySec", "2");
    const engine = new AlarmEngine(db);
    engine.syncExternalArmState(true);
    expect(engine.getStatus().remainingSec).toBe(2);

    // Would still be ARMING at 2s if this had used the normal 5s exitDelaySec instead.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(engine.getStatus().state).toBe("ARMED");
  });

  it("syncExternalArmState(true) defaults its sync delay to 5s when externalArmSyncDelaySec isn't configured", () => {
    const engine = new AlarmEngine(db);
    engine.syncExternalArmState(true);
    expect(engine.getStatus().remainingSec).toBe(5);
  });

  it("syncExternalArmState(false) disarms from ARMED", async () => {
    await createPin(db, "Alex", "1234");
    const engine = new AlarmEngine(db);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.getStatus().state).toBe("ARMED");

    engine.syncExternalArmState(false);
    expect(engine.getStatus().state).toBe("DISARMED");
    // Caught live in manual testing: a console-triggered disarm must not
    // greet the kiosk with "Welcome, UniFi" — that field is for a human's
    // PIN-disarm name.
    expect(engine.getStatus().welcomeName).toBeNull();
  });

  it("syncExternalArmState(false) also silences a real ALARM, without ever triggering duress", async () => {
    const sent: AlertPayload[] = [];
    const notifier: Notifier = {
      send: async (alert) => {
        sent.push(alert);
      },
    };
    const engine = new AlarmEngine(db, notifier);
    engine.armWithoutPin("Panel");
    await vi.advanceTimersByTimeAsync(5_000);
    engine.handleSensorTrip("back-door", "instant");
    expect(engine.getStatus().state).toBe("ALARM");

    engine.syncExternalArmState(false);
    expect(engine.getStatus().state).toBe("DISARMED");
    expect(sent).not.toContainEqual(expect.objectContaining({ kind: "DURESS" }));
  });

  it("syncExternalArmState only dispatches on a real edge, not on every call with the same value", () => {
    const engine = new AlarmEngine(db);
    engine.syncExternalArmState(true);
    const armingCount = () => listAudit(db, 20).filter((a) => a.event === "arming_started").length;
    expect(armingCount()).toBe(1);

    // Repeated "still armed" polls must not re-dispatch ARM (which would spam
    // "arm_ignored_already_arming" on every tick if it did).
    engine.syncExternalArmState(true);
    engine.syncExternalArmState(true);
    expect(armingCount()).toBe(1);
    expect(listAudit(db, 20).some((a) => a.event === "arm_ignored_already_arming")).toBe(false);
  });

  it("syncExternalArmState(true) does nothing while already in ALARM — a real trip stays authoritative", async () => {
    const engine = new AlarmEngine(db);
    engine.armWithoutPin("Panel");
    await vi.advanceTimersByTimeAsync(5_000);
    engine.handleSensorTrip("back-door", "instant");
    expect(engine.getStatus().state).toBe("ALARM");

    engine.syncExternalArmState(true);
    expect(engine.getStatus().state).toBe("ALARM");
  });

  it("a sensor trip while armed starts the entry delay, and ALARM fires if nobody disarms", async () => {
    await createPin(db, "Alex", "1234");
    const engine = new AlarmEngine(db);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(engine.getStatus().state).toBe("ARMED");

    engine.handleSensorTrip("front-door", "delayed");
    expect(engine.getStatus().state).toBe("ENTRY_DELAY");
    expect(engine.getStatus().remainingSec).toBe(10);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(engine.getStatus().state).toBe("ALARM");
    expect(engine.getStatus().triggeredBy).toEqual({ sensorId: "front-door" });
  });

  it("surfaces triggeredBy during the entry delay too, not just once it reaches ALARM", async () => {
    await createPin(db, "Alex", "1234");
    const engine = new AlarmEngine(db);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);

    engine.handleSensorTrip("front-door", "delayed");
    expect(engine.getStatus().triggeredBy).toEqual({ sensorId: "front-door" });
  });

  it("triggeredBy is null outside ALARM/ENTRY_DELAY", () => {
    const engine = new AlarmEngine(db);
    expect(engine.getStatus().triggeredBy).toBeNull();
  });

  it("an instant sensor trip surfaces triggeredBy immediately", async () => {
    await createPin(db, "Alex", "1234");
    const engine = new AlarmEngine(db);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);

    engine.handleSensorTrip("back-door", "instant");
    expect(engine.getStatus().state).toBe("ALARM");
    expect(engine.getStatus().triggeredBy).toEqual({ sensorId: "back-door" });
  });

  it("disarming during the entry delay cancels the timer and stays quiet", async () => {
    await createPin(db, "Alex", "1234");
    const engine = new AlarmEngine(db);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);
    engine.handleSensorTrip("front-door", "delayed");

    const result = await engine.disarm("1234");
    expect(result.ok).toBe(true);
    expect(engine.getStatus().state).toBe("DISARMED");

    await vi.advanceTimersByTimeAsync(60_000);
    expect(engine.getStatus().state).toBe("DISARMED");
  });

  it("disarming sets a first-name welcomeName that clears on re-arming", async () => {
    await createPin(db, "Jonathan Chansin", "1234");
    const engine = new AlarmEngine(db);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);

    expect(engine.getStatus().welcomeName).toBeNull(); // nobody's disarmed yet
    await engine.disarm("1234");
    expect(engine.getStatus().welcomeName).toBe("Jonathan");

    // Re-arming clears it immediately, even though the 5-minute window
    // hasn't elapsed — a new person could be the one arming.
    await engine.arm("1234");
    expect(engine.getStatus().welcomeName).toBeNull();
  });

  it("welcomeName expires after 5 minutes", async () => {
    await createPin(db, "Jonathan Chansin", "1234");
    const engine = new AlarmEngine(db);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);
    await engine.disarm("1234");
    expect(engine.getStatus().welcomeName).toBe("Jonathan");

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
    expect(engine.getStatus().welcomeName).toBeNull();
  });

  it("a duress PIN disarms normally but is audibly flagged in the audit log", async () => {
    await createPin(db, "Alex", "1234");
    await createPin(db, "Under duress", "9999", true);
    const engine = new AlarmEngine(db);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);

    const result = await engine.disarm("9999");
    expect(result.ok).toBe(true);
    expect(engine.getStatus().state).toBe("DISARMED");

    const audit = listAudit(db, 10);
    expect(audit.some((a) => a.event === "disarmed")).toBe(true);
  });

  it("a duress disarm fires a distinct DURESS alert through the notifier", async () => {
    await createPin(db, "Alex", "1234");
    await createPin(db, "Under duress", "9999", true);
    const sent: { kind: string }[] = [];
    const notifier: Notifier = { send: vi.fn(async (alert) => void sent.push(alert)) };
    const engine = new AlarmEngine(db, notifier);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);

    await engine.disarm("9999");

    expect(sent).toContainEqual(expect.objectContaining({ kind: "DURESS" }));
    expect(sent.some((a) => a.kind === "ALARM")).toBe(false);
  });

  it("triggers the configured siren webhook on ALARM", async () => {
    setConfigValue(db, "sirenAlarmManagerWebhookId", "siren-webhook-1");
    await createPin(db, "Alex", "1234");
    const protectClient: ProtectClient = {
      getSnapshot: vi.fn(async () => null),
      getLiveViewUrl: vi.fn(() => ""),
      listCameras: vi.fn(async () => []),
      triggerAlarmManagerWebhook: vi.fn(async () => true),
    };
    const engine = new AlarmEngine(db, undefined, protectClient);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);

    engine.handleSensorTrip("back-door", "instant");
    await vi.advanceTimersByTimeAsync(0);

    expect(protectClient.triggerAlarmManagerWebhook).toHaveBeenCalledWith("siren-webhook-1");
  });

  it("never triggers a siren when sirenAlarmManagerWebhookId isn't configured", async () => {
    await createPin(db, "Alex", "1234");
    const protectClient: ProtectClient = {
      getSnapshot: vi.fn(async () => null),
      getLiveViewUrl: vi.fn(() => ""),
      listCameras: vi.fn(async () => []),
      triggerAlarmManagerWebhook: vi.fn(async () => true),
    };
    const engine = new AlarmEngine(db, undefined, protectClient);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);

    engine.handleSensorTrip("back-door", "instant");
    await vi.advanceTimersByTimeAsync(0);

    expect(protectClient.triggerAlarmManagerWebhook).not.toHaveBeenCalled();
  });

  it("never triggers the siren on a duress disarm, even out of a real ALARM with the webhook configured — duress must stay silent", async () => {
    setConfigValue(db, "sirenAlarmManagerWebhookId", "siren-webhook-1");
    await createPin(db, "Alex", "1234");
    await createPin(db, "Under duress", "9999", true);
    const protectClient: ProtectClient = {
      getSnapshot: vi.fn(async () => null),
      getLiveViewUrl: vi.fn(() => ""),
      listCameras: vi.fn(async () => []),
      triggerAlarmManagerWebhook: vi.fn(async () => true),
    };
    const engine = new AlarmEngine(db, undefined, protectClient);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(5_000);
    engine.handleSensorTrip("back-door", "instant");
    await vi.advanceTimersByTimeAsync(0);
    expect(engine.getStatus().state).toBe("ALARM");
    (protectClient.triggerAlarmManagerWebhook as ReturnType<typeof vi.fn>).mockClear(); // clear the trip's own legitimate call

    await engine.disarm("9999");

    expect(protectClient.triggerAlarmManagerWebhook).not.toHaveBeenCalled();
  });

  it("locks the keypad after repeated invalid PINs, even when each attempt claims a different source", async () => {
    await createPin(db, "Alex", "1234");
    const engine = new AlarmEngine(db);

    // The source comes from X-Forwarded-For, which a caller can rotate on every request.
    for (let i = 0; i < 5; i++) {
      await engine.arm("0000", `spoofed-${i}`);
    }
    const locked = await engine.arm("1234", "yet-another-source");
    expect(locked.ok).toBe(false);
    expect(locked.lockedOut).toBe(true);
    expect(engine.getStatus().state).toBe("DISARMED");
  });

  it("a legitimate PIN in between doesn't reset an attacker's failures", async () => {
    await createPin(db, "Alex", "1234");
    const engine = new AlarmEngine(db);

    for (let i = 0; i < 4; i++) await engine.disarm("0000", "attacker");
    // Someone disarms normally at the kiosk.
    expect((await engine.disarm("1234", "kiosk")).ok).toBe(true);
    // The attacker's next wrong PIN is still the 5th, so it locks out instead of starting a fresh count.
    const fifth = await engine.disarm("0000", "attacker");
    expect(fifth.lockedOut).toBe(true);
  });

  it("an ALARM from a sensor with a mapped camera attaches its snapshot and live-view link", async () => {
    await createPin(db, "Alex", "1234");
    upsertSensor(db, "back-door", "Back Door", "instant", "cam-1");
    const sent: AlertPayload[] = [];
    const notifier: Notifier = { send: vi.fn(async (alert) => void sent.push(alert)) };
    const snapshot: Snapshot = { buffer: Buffer.from([9, 9, 9]), contentType: "image/jpeg" };
    const protectClient: ProtectClient = {
      getSnapshot: vi.fn(async () => snapshot),
      getLiveViewUrl: vi.fn(() => "https://udm.local/protect/dashboard/cam-1"),
      listCameras: vi.fn(async () => []),
      triggerAlarmManagerWebhook: vi.fn(async () => false),
    };
    const engine = new AlarmEngine(db, notifier, protectClient);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(30_000);

    engine.handleSensorTrip("back-door", "instant");
    await vi.advanceTimersByTimeAsync(0);

    expect(protectClient.getSnapshot).toHaveBeenCalledWith("cam-1");
    expect(sent).toContainEqual(
      expect.objectContaining({
        kind: "ALARM",
        snapshot,
        liveViewUrl: "https://udm.local/protect/dashboard/cam-1",
      }),
    );
  });

  it("a snapshot fetch failure still sends the alert, just without an image", async () => {
    await createPin(db, "Alex", "1234");
    upsertSensor(db, "back-door", "Back Door", "instant", "cam-1");
    const sent: AlertPayload[] = [];
    const notifier: Notifier = { send: vi.fn(async (alert) => void sent.push(alert)) };
    const protectClient: ProtectClient = {
      getSnapshot: vi.fn(async () => null), // camera unreachable, offline, etc.
      getLiveViewUrl: vi.fn(() => "https://udm.local/protect/dashboard/cam-1"),
      listCameras: vi.fn(async () => []),
      triggerAlarmManagerWebhook: vi.fn(async () => false),
    };
    const engine = new AlarmEngine(db, notifier, protectClient);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(30_000);

    engine.handleSensorTrip("back-door", "instant");
    await vi.advanceTimersByTimeAsync(0);

    expect(sent).toContainEqual(expect.objectContaining({ kind: "ALARM", snapshot: null }));
  });

  it("a sensor with no mapped camera still alerts, with no snapshot attempted", async () => {
    await createPin(db, "Alex", "1234");
    const sent: AlertPayload[] = [];
    const notifier: Notifier = { send: vi.fn(async (alert) => void sent.push(alert)) };
    const protectClient: ProtectClient = {
      getSnapshot: vi.fn(async () => null),
      getLiveViewUrl: vi.fn(() => ""),
      listCameras: vi.fn(async () => []),
      triggerAlarmManagerWebhook: vi.fn(async () => false),
    };
    const engine = new AlarmEngine(db, notifier, protectClient);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(30_000);

    engine.handleSensorTrip("unmapped-sensor", "instant");
    await vi.advanceTimersByTimeAsync(0);

    expect(protectClient.getSnapshot).not.toHaveBeenCalled();
    expect(sent).toContainEqual(expect.objectContaining({ kind: "ALARM", snapshot: null }));
  });

  it("falls back to the default camera setting when the sensor has no camera of its own mapped", async () => {
    saveSettings("console", { protectDefaultCameraId: "cam-default" }, db);
    await createPin(db, "Alex", "1234");
    const sent: AlertPayload[] = [];
    const notifier: Notifier = { send: vi.fn(async (alert) => void sent.push(alert)) };
    const snapshot: Snapshot = { buffer: Buffer.from([9, 9, 9]), contentType: "image/jpeg" };
    const protectClient: ProtectClient = {
      getSnapshot: vi.fn(async () => snapshot),
      getLiveViewUrl: vi.fn(() => "https://udm.local/protect/dashboard/cam-default"),
      listCameras: vi.fn(async () => []),
      triggerAlarmManagerWebhook: vi.fn(async () => false),
    };
    const engine = new AlarmEngine(db, notifier, protectClient);
    await engine.arm("1234");
    await vi.advanceTimersByTimeAsync(30_000);

    engine.handleSensorTrip("unmapped-sensor", "instant");
    await vi.advanceTimersByTimeAsync(0);

    expect(protectClient.getSnapshot).toHaveBeenCalledWith("cam-default");
    expect(sent).toContainEqual(
      expect.objectContaining({
        kind: "ALARM",
        snapshot,
        liveViewUrl: "https://udm.local/protect/dashboard/cam-default",
      }),
    );
  });

  it("sensor trips while disarmed never start a timer or reach ALARM", async () => {
    const engine = new AlarmEngine(db);
    engine.handleSensorTrip("front-door", "instant");
    expect(engine.getStatus().state).toBe("DISARMED");
    expect(engine.getStatus().remainingSec).toBeNull();
  });

  it("restart mid-timer restores state and keeps running (new timer starts on next dispatch)", async () => {
    await createPin(db, "Alex", "1234");
    const engineA = new AlarmEngine(db);
    await engineA.arm("1234");
    expect(engineA.getStatus().state).toBe("ARMING");

    // Simulate a restart: a fresh engine over the same db, without waiting out the exit delay.
    const engineB = new AlarmEngine(db);
    expect(engineB.getStatus().state).toBe("ARMING");
  });

  // The state name surviving a restart was already covered above, but the
  // setTimeout driving the countdown lives only in memory. Before resumeTimer()
  // existed, a restart here left the system wedged forever — reproduced live
  // against a real build: ENTRY_DELAY never escalated to ALARM, and no alert
  // was ever sent, with an intruder already inside.
  describe("resuming a countdown after a restart", () => {
    it("ENTRY_DELAY still escalates to ALARM after a restart, and alerts", async () => {
      const sent: AlertPayload[] = [];
      const notifier: Notifier = { send: async (a) => void sent.push(a) };
      await createPin(db, "Alex", "1234");
      upsertSensor(db, "front-door", "Front Door", "delayed", null, null, "door");

      const engineA = new AlarmEngine(db, notifier, nullProtect());
      await engineA.arm("1234");
      await vi.advanceTimersByTimeAsync(5_000);
      engineA.handleSensorTrip("front-door", "delayed");
      expect(engineA.getStatus().state).toBe("ENTRY_DELAY");

      // Restart 2s into the 10s entry delay: drop engine A's timer, rebuild
      // from the same DB, and let the ORIGINAL deadline arrive.
      await vi.advanceTimersByTimeAsync(2_000);
      engineA.stopForTest();
      const engineB = new AlarmEngine(db, notifier, nullProtect());
      expect(engineB.getStatus().state).toBe("ENTRY_DELAY");
      // Countdown picks up where it left off rather than restarting at 10s.
      expect(engineB.getStatus().remainingSec).toBe(8);

      await vi.advanceTimersByTimeAsync(8_000);
      expect(engineB.getStatus().state).toBe("ALARM");
      expect(sent.filter((a) => a.kind === "ALARM")).toHaveLength(1);
    });

    it("an entry deadline that passed while the process was down fires immediately on boot", async () => {
      const sent: AlertPayload[] = [];
      const notifier: Notifier = { send: async (a) => void sent.push(a) };
      await createPin(db, "Alex", "1234");
      upsertSensor(db, "front-door", "Front Door", "delayed", null, null, "door");

      const engineA = new AlarmEngine(db, notifier, nullProtect());
      await engineA.arm("1234");
      await vi.advanceTimersByTimeAsync(5_000);
      engineA.handleSensorTrip("front-door", "delayed");
      engineA.stopForTest();

      // The box was down for an hour, well past the 10s entry delay.
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      const engineB = new AlarmEngine(db, notifier, nullProtect());
      await vi.advanceTimersByTimeAsync(0);

      expect(engineB.getStatus().state).toBe("ALARM");
      expect(sent.filter((a) => a.kind === "ALARM")).toHaveLength(1);
    });

    it("ARMING still settles to ARMED after a restart", async () => {
      await createPin(db, "Alex", "1234");
      const engineA = new AlarmEngine(db);
      await engineA.arm("1234");
      await vi.advanceTimersByTimeAsync(1_000);
      engineA.stopForTest();

      const engineB = new AlarmEngine(db);
      expect(engineB.getStatus().state).toBe("ARMING");
      await vi.advanceTimersByTimeAsync(4_000);
      expect(engineB.getStatus().state).toBe("ARMED");
    });

    it("does not arm a timer for a settled state", () => {
      db.prepare("INSERT INTO alarm_state (id, name, since) VALUES (1, 'ARMED', ?)").run(new Date().toISOString());
      const engine = new AlarmEngine(db);
      expect(engine.getStatus().state).toBe("ARMED");
      expect(engine.getStatus().remainingSec).toBeNull();
    });

    it("falls back to since + the configured delay when no deadline was persisted (a pre-migration-7 row)", async () => {
      db.prepare("INSERT INTO alarm_state (id, name, since, timer_ends_at) VALUES (1, 'ARMING', ?, NULL)").run(
        new Date(Date.now() - 2_000).toISOString(),
      );
      const engine = new AlarmEngine(db);
      expect(engine.getStatus().state).toBe("ARMING");
      // 5s exitDelaySec measured from `since`, 2s of which already elapsed.
      expect(engine.getStatus().remainingSec).toBe(3);
      await vi.advanceTimersByTimeAsync(3_000);
      expect(engine.getStatus().state).toBe("ARMED");
    });
  });

  describe("a failing database write never stops the alarm", () => {
    it("keeps the entry timer running and still reaches ALARM when persistState throws", async () => {
      const sent: AlertPayload[] = [];
      const notifier: Notifier = { send: async (a) => void sent.push(a) };
      await createPin(db, "Alex", "1234");
      const engine = new AlarmEngine(db, notifier, nullProtect());
      await engine.arm("1234");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(engine.getStatus().state).toBe("ARMED");

      // Full disk / locked DB: every alarm_state write fails from here on.
      const realPrepare = db.prepare.bind(db);
      const failingPrepare = ((sql: string) => {
        if (sql.includes("INSERT INTO alarm_state")) throw new Error("SQLITE_FULL: database or disk is full");
        return realPrepare(sql);
      }) as typeof db.prepare;
      db.prepare = failingPrepare;

      expect(() => engine.handleSensorTrip("front-door", "delayed")).not.toThrow();
      expect(engine.getStatus().state).toBe("ENTRY_DELAY");
      expect(engine.getStatus().remainingSec).toBe(10);

      await vi.advanceTimersByTimeAsync(10_000);
      expect(engine.getStatus().state).toBe("ALARM");
      expect(sent.filter((a) => a.kind === "ALARM")).toHaveLength(1);
      db.prepare = realPrepare;
    });

    it("a failing audit write still lets the timer and alert effects run", async () => {
      const sent: AlertPayload[] = [];
      const notifier: Notifier = { send: async (a) => void sent.push(a) };
      await createPin(db, "Alex", "1234");
      const engine = new AlarmEngine(db, notifier, nullProtect());
      await engine.arm("1234");
      await vi.advanceTimersByTimeAsync(5_000);

      const realPrepare = db.prepare.bind(db);
      const failingPrepare = ((sql: string) => {
        if (sql.includes("INSERT INTO audit")) throw new Error("SQLITE_FULL: database or disk is full");
        return realPrepare(sql);
      }) as typeof db.prepare;
      db.prepare = failingPrepare;

      // ALERT_ALARM is emitted alongside the AUDIT effect — the audit failing
      // must not swallow the alert, which is the part that wakes a human.
      expect(() => engine.handleSensorTrip("back-door", "instant")).not.toThrow();
      expect(engine.getStatus().state).toBe("ALARM");
      db.prepare = realPrepare;
      await vi.advanceTimersByTimeAsync(0);
      expect(sent.filter((a) => a.kind === "ALARM")).toHaveLength(1);
    });
  });

  describe("PIN attempt rate limiting", () => {
    it("concurrent wrong PINs from one source still hit the lockout", async () => {
      await createPin(db, "Alex", "1234");
      const engine = new AlarmEngine(db);
      engine.armWithoutPin("Panel", true);

      // Fired in parallel, not awaited in sequence: before the attempts were
      // serialized, all 20 cleared the isLockedOut() gate during argon2's
      // await and none was ever rejected — reproduced at 20/20.
      const results = await Promise.all(Array.from({ length: 20 }, () => engine.disarm("0000", "attacker")));
      expect(results.filter((r) => r.lockedOut).length).toBeGreaterThan(0);
      // The default is 5 attempts, so at most 5 reach argon2 (audited as
      // disarm_failed_invalid_pin) before the rest are turned away
      // pre-emptively (disarm_locked_out) — checked via the audit log, not
      // each result's own lockedOut flag, since the 5th failure (the one that
      // tips the bucket over) now reports lockedOut:true on itself too (see
      // the PIN_LOCKOUT dispatch below), not just the ones rejected after it.
      const audit = listAudit(db, 30);
      expect(audit.filter((a) => a.event === "disarm_failed_invalid_pin")).toHaveLength(5);
      expect(audit.filter((a) => a.event === "disarm_locked_out")).toHaveLength(15);
    });

    it("counts down remainingAttempts on each wrong PIN, then triggers the alarm on the one that locks it out", async () => {
      await createPin(db, "Alex", "1234");
      const engine = new AlarmEngine(db);

      const first = await engine.disarm("0000", "kiosk");
      expect(first).toEqual({ ok: false, remainingAttempts: 4 });
      const second = await engine.disarm("0000", "kiosk");
      expect(second).toEqual({ ok: false, remainingAttempts: 3 });
      const third = await engine.disarm("0000", "kiosk");
      expect(third).toEqual({ ok: false, remainingAttempts: 2 });
      const fourth = await engine.disarm("0000", "kiosk");
      expect(fourth).toEqual({ ok: false, remainingAttempts: 1 });

      // The 5th wrong PIN is the one that tips the bucket into lockout —
      // its own result already says lockedOut, not remainingAttempts: 0,
      // since there's no next attempt left to count down to.
      expect(engine.getStatus().state).toBe("DISARMED");
      const fifth = await engine.disarm("0000", "kiosk");
      expect(fifth).toEqual({ ok: false, lockedOut: true });
      expect(engine.getStatus().state).toBe("ALARM");
      expect(listAudit(db, 10).some((a) => a.event === "alarm_pin_lockout")).toBe(true);
    });

    it("triggers the alarm on lockout even while already armed, same as while disarmed", async () => {
      await createPin(db, "Alex", "1234");
      const engine = new AlarmEngine(db);
      engine.armWithoutPin("Panel", true);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(engine.getStatus().state).toBe("ARMED");

      // Own rateLimitKey, not shared with the test above — rate-limit
      // buckets live on globalThis, independent of the per-test db, so
      // reusing a key would find it already locked out from there.
      for (let i = 0; i < 4; i++) await engine.disarm("0000", "kiosk-armed");
      await engine.disarm("0000", "kiosk-armed");
      expect(engine.getStatus().state).toBe("ALARM");
    });

    it("the PIN bucket is namespaced, so it can't be reached by spoofing another guard's key", async () => {
      const { isLockedOut } = await import("@/lib/services/rate-limit");
      await createPin(db, "Alex", "1234");
      const engine = new AlarmEngine(db);

      // A caller controls X-Forwarded-For, so it controls this value entirely.
      for (let i = 0; i < 6; i++) await engine.disarm("0000", "webhook_1.2.3.4");

      // The failures land in the shared PIN bucket only — the webhook guard's
      // own bucket for that source is untouched, so UniFi's sensor webhook
      // keeps working. (lib/auth/client-key.ts also strips ":" so the spoofed
      // value can't be shaped like another namespace's key in the first place.)
      expect(isLockedOut("pin:all")).toBe(true);
      expect(isLockedOut("webhook:1.2.3.4")).toBe(false);
      expect(isLockedOut("webhook:webhook_1.2.3.4")).toBe(false);
    });
  });

  describe("arming blocked by an open door sensor", () => {
    it("arm() with a valid PIN is rejected while a non-ignored door sensor is open, and stays DISARMED", async () => {
      await createPin(db, "Alex", "1234");
      openDoorSensor("front-door", "Front Door");
      const engine = new AlarmEngine(db);

      const result = await engine.arm("1234");
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("sensors_open");
      expect(result.openSensors).toEqual([{ id: expect.any(Number), name: "Front Door" }]);
      expect(engine.getStatus().state).toBe("DISARMED");
      const audit = listAudit(db, 10);
      expect(audit.some((a) => a.event === "arm_rejected_sensors_open")).toBe(true);
    });

    it("arm() with force:true arms anyway and audits the override distinctly", async () => {
      await createPin(db, "Alex", "1234");
      openDoorSensor("front-door", "Front Door");
      const engine = new AlarmEngine(db);

      const result = await engine.arm("1234", "unknown", true);
      expect(result.ok).toBe(true);
      expect(engine.getStatus().state).toBe("ARMING");
      const audit = listAudit(db, 10);
      expect(audit.some((a) => a.event === "arm_forced_with_sensors_open")).toBe(true);
    });

    it("armWithoutPin() is rejected while a door is open, and force:true overrides it", () => {
      openDoorSensor("front-door", "Front Door");
      const engine = new AlarmEngine(db);

      const blocked = engine.armWithoutPin("Panel");
      expect(blocked.ok).toBe(false);
      expect(blocked.reason).toBe("sensors_open");
      expect(engine.getStatus().state).toBe("DISARMED");

      const forced = engine.armWithoutPin("Panel", true);
      expect(forced.ok).toBe(true);
      expect(engine.getStatus().state).toBe("ARMING");
    });

    it("does not block arming on a door sensor set to mode 'ignore'", async () => {
      await createPin(db, "Alex", "1234");
      upsertSensor(db, "loading-dock", "Loading Dock", "ignore", null, null, "door");
      db.prepare("UPDATE sensors SET current_state = 'open' WHERE unifi_id = ?").run("loading-dock");
      const engine = new AlarmEngine(db);

      const result = await engine.arm("1234");
      expect(result.ok).toBe(true);
      expect(engine.getStatus().state).toBe("ARMING");
    });

    it("does not block arming on an open sensor that isn't classified as a door", async () => {
      await createPin(db, "Alex", "1234");
      upsertSensor(db, "motion-1", "Hallway Motion", "instant", null, null, "motion");
      db.prepare("UPDATE sensors SET current_state = 'open' WHERE unifi_id = ?").run("motion-1");
      const engine = new AlarmEngine(db);

      const result = await engine.arm("1234");
      expect(result.ok).toBe(true);
      expect(engine.getStatus().state).toBe("ARMING");
    });

    it("syncExternalArmState() is never gated by an open door — it must mirror UniFi's real state", () => {
      openDoorSensor("front-door", "Front Door");
      const engine = new AlarmEngine(db);

      engine.syncExternalArmState(true);
      expect(engine.getStatus().state).toBe("ARMING");
    });
  });

  describe("exit-delay door chime (armingTripCount)", () => {
    it("is null outside ARMING", () => {
      const engine = new AlarmEngine(db);
      expect(engine.getStatus().armingTripCount).toBeNull();
    });

    it("starts at 0 once arming begins", async () => {
      await createPin(db, "Alex", "1234");
      const engine = new AlarmEngine(db);
      await engine.arm("1234");
      expect(engine.getStatus().armingTripCount).toBe(0);
    });

    it("increments on a door sensor's trip during the exit delay, but not on a non-door sensor's", async () => {
      await createPin(db, "Alex", "1234");
      upsertSensor(db, "front-door", "Front Door", "delayed", null, null, "door");
      upsertSensor(db, "hallway-motion", "Hallway Motion", "delayed", null, null, "motion");
      const engine = new AlarmEngine(db);
      await engine.arm("1234");

      engine.handleSensorTrip("hallway-motion", "delayed");
      expect(engine.getStatus().armingTripCount).toBe(0);

      engine.handleSensorTrip("front-door", "delayed");
      expect(engine.getStatus().armingTripCount).toBe(1);

      engine.handleSensorTrip("front-door", "delayed");
      expect(engine.getStatus().armingTripCount).toBe(2);
    });

    it("names the tripped doors, distinct, most recent last", async () => {
      await createPin(db, "Alex", "1234");
      upsertSensor(db, "front-door", "Front Door", "delayed", null, null, "door");
      upsertSensor(db, "back-door", "Back Door", "delayed", null, null, "door");
      const engine = new AlarmEngine(db);
      expect(engine.getStatus().armingTripDoors).toBeNull();
      await engine.arm("1234");
      expect(engine.getStatus().armingTripDoors).toEqual([]);
      engine.handleSensorTrip("front-door", "delayed");
      engine.handleSensorTrip("back-door", "delayed");
      engine.handleSensorTrip("front-door", "delayed");
      expect(engine.getStatus().armingTripDoors).toEqual(["Back Door", "Front Door"]);
    });

    it("resets to 0 on the next arming cycle", async () => {
      await createPin(db, "Alex", "1234");
      upsertSensor(db, "front-door", "Front Door", "delayed", null, null, "door");
      const engine = new AlarmEngine(db);
      await engine.arm("1234");
      engine.handleSensorTrip("front-door", "delayed");
      expect(engine.getStatus().armingTripCount).toBe(1);

      await vi.advanceTimersByTimeAsync(5_000); // ARMED
      await engine.disarm("1234");
      await engine.arm("1234");
      expect(engine.getStatus().armingTripCount).toBe(0);
    });

    it("also counts a door trip when ARMING was entered via syncExternalArmState (console-triggered arm)", () => {
      upsertSensor(db, "front-door", "Front Door", "delayed", null, null, "door");
      const engine = new AlarmEngine(db);
      engine.syncExternalArmState(true);
      expect(engine.getStatus().state).toBe("ARMING");

      engine.handleSensorTrip("front-door", "delayed");
      expect(engine.getStatus().armingTripCount).toBe(1);
    });
  });

  describe("panel status extras", () => {
    it("lists gating doors with their open state, ignoring non-door and ignored sensors", () => {
      upsertSensor(db, "front-door", "Front Door", "delayed", null, null, "door");
      upsertSensor(db, "back-door", "Back Door", "delayed", null, null, "door");
      upsertSensor(db, "hall", "Hall Motion", "delayed", null, null, "motion");
      upsertSensor(db, "ignored-door", "Ignored", "ignore", null, null, "door");
      setSensorState(db, "back-door", "open");
      const doors = new AlarmEngine(db).getStatus().doors;
      expect(doors.map((d) => [d.name, d.open])).toEqual([
        ["Front Door", false],
        ["Back Door", true],
      ]);
    });

    it("reports test mode from the panelTestMode config key", () => {
      const engine = new AlarmEngine(db);
      expect(engine.getStatus().testMode).toBe(false);
      setConfigValue(db, "panelTestMode", "true");
      expect(engine.getStatus().testMode).toBe(true);
      setConfigValue(db, "panelTestMode", "false");
      expect(engine.getStatus().testMode).toBe(false);
    });

    it("reports who armed and when, only while not disarmed", async () => {
      await createPin(db, "Alex", "1234");
      const engine = new AlarmEngine(db);
      expect(engine.getStatus().armedBy).toBeNull();
      await engine.arm("1234");
      const st = engine.getStatus();
      expect(st.armedBy).toBe("Alex");
      expect(st.armedAt).toBe(Date.now());
      await engine.disarm("1234");
      expect(engine.getStatus().armedBy).toBeNull();
    });
  });
});
