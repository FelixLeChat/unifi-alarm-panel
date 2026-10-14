import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { recordAudit } from "@/lib/services/audit";
import { getConfigValue, getDelays, getExternalArmSyncDelaySec, isPanelTestMode } from "@/lib/services/config";
import { getNotifier, type Notifier } from "@/lib/services/notifier";
import { verifyPin } from "@/lib/services/pins";
import { getRemainingAttempts, isLockedOut, recordFailure, recordSuccess } from "@/lib/services/rate-limit";
import { getProtectClient, type ProtectClient } from "@/lib/services/protect-client";
import { getSensor, listDoorStatuses, listOpenGatingSensors } from "@/lib/services/sensors";
import { getSetting } from "@/lib/services/settings";
import { transition, type AlarmEvent, type AlarmState, type AlarmStateName, type Effect, type SensorMode, type TransitionConfig } from "@/lib/state/machine";

// The actorLabel syncExternalArmState() uses — pulled out so dispatch()'s
// welcome-name guard below can reference the exact same value rather than a
// second hard-coded "UniFi" string drifting out of sync with it.
const PROTECT_SYNC_ACTOR = "UniFi";
// Actors that aren't someone the kiosk should say "Welcome, <name>" to.
const PANEL_ACTOR = "Panel";
const NON_PERSON_ACTORS = new Set([PROTECT_SYNC_ACTOR, PANEL_ACTOR]);

const STATE_NAMES: AlarmStateName[] = ["DISARMED", "ARMING", "ARMED", "ENTRY_DELAY", "ALARM"];

function isValidStateName(name: string): name is AlarmStateName {
  return (STATE_NAMES as string[]).includes(name);
}

export interface OpenSensor {
  id: number;
  name: string;
}

export interface ArmResult {
  ok: boolean;
  lockedOut?: boolean;
  reason?: "sensors_open";
  openSensors?: OpenSensor[];
}

export interface DisarmResult {
  ok: boolean;
  lockedOut?: boolean;
  /** Only set on a wrong-PIN failure — how many more attempts remain before this source locks out (and, per PIN_LOCKOUT, triggers the alarm). Absent on success or once already locked out (there's nothing left to count down). */
  remainingAttempts?: number;
}

export interface EngineStatus {
  state: AlarmStateName;
  since: string;
  remainingSec: number | null;
  welcomeName: string | null;
  triggeredBy: { sensorId: string } | null;
  // Label of the sensor behind triggeredBy, for the panel's entry-delay message.
  triggeredByName: string | null;
  // Only non-null while ARMING — see the chime in public/panel.js. Counts
  // door-sensor trips during the current exit delay, so the panel can play
  // a distinct tone once per trip without a new Effect type in the pure
  // state machine (lib/state/machine.ts already emits sensor_trip_while_arming).
  armingTripCount: number | null;
  // Labels of the distinct door sensors tripped during the current exit delay (most recent last), so the panel can say which door. Null outside ARMING.
  armingTripDoors: string[] | null;
  // Every gating door with its current state, in every alarm state.
  doors: { id: number; name: string; open: boolean }[];
  // Who/what armed the system and when (ms epoch). In memory only: null after a restart or while disarmed.
  armedBy: string | null;
  armedAt: number | null;
  // Admin "Test mode": the kiosk stays silent (see isPanelTestMode).
  testMode: boolean;
}

// How long the kiosk shows "Welcome, <name>" after a disarm — see
// getStatus()'s welcomeName. In-memory only (not persisted): a process
// restart just means the welcome message resets, which is a fine trade for
// not adding a DB column for something this low-stakes.
const WELCOME_WINDOW_MS = 5 * 60 * 1000;

interface AlarmStateRow {
  name: string;
  since: string;
  triggered_by_sensor_id: string | null;
  timer_ends_at: string | null;
}

interface RestoredState {
  state: AlarmState;
  timerEndsAt: number | null;
}

// Serializes the check-then-act PIN sequence in arm()/disarm() (isLockedOut ->
// argon2 verify -> recordFailure). argon2 is deliberately slow (~100ms), which
// is long enough that concurrent attempts from one source would otherwise each
// clear the lockout gate before the first of them recorded a failure — turning
// a 5-attempt lockout into "as many attempts as you can hold open at once".
// On globalThis for the same reason as getDb()/getEngine(): each Next-compiled
// route bundle gets its own module copy, and two chains would not serialize
// against each other.
declare global {
  var __uapPinAttemptChain: Promise<unknown> | undefined;
}

function serializePinAttempt<T>(fn: () => Promise<T>): Promise<T> {
  const chain = globalThis.__uapPinAttemptChain ?? Promise.resolve();
  // .then(fn, fn) so a rejected predecessor still lets the next attempt run.
  const result = chain.then(fn, fn);
  globalThis.__uapPinAttemptChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// Every rate-limit bucket key is "<namespace>:<source>". The PIN bucket was
// previously the bare source, which let a caller aim failures at another
// guard's namespace by spoofing X-Forwarded-For (lib/auth/client-key.ts also
// neutralizes ":" now, so this is belt and braces).
function pinBucket(source: string): string {
  return `pin:${source}`;
}

/**
 * Owns the timers and persistence around the pure state machine. One
 * instance per process — see instrumentation.ts for the single boot point.
 */
export class AlarmEngine {
  private readonly db: Database.Database;
  // Resolved on every use, not captured once: the defaults rebuild when the
  // settings change in the admin UI (see lib/services/settings.ts). Tests
  // pass fixed instances.
  private readonly notifierSource: () => Notifier;
  private readonly protectClientSource: () => ProtectClient;
  private state: AlarmState;
  private timer: NodeJS.Timeout | null = null;
  private timerEndsAt: number | null = null;
  private lastDisarmedBy: { firstName: string; at: number } | null = null;
  // Reset to 0 on every "arming_started", incremented only for a door
  // sensor's trip during the exit delay — see EngineStatus.armingTripCount.
  private armingTripCount = 0;
  private armingTripDoors: string[] = [];
  private armedInfo: { by: string; at: number } | null = null;

  constructor(db: Database.Database, notifier?: Notifier, protectClient?: ProtectClient) {
    this.db = db;
    this.notifierSource = notifier ? () => notifier : getNotifier;
    this.protectClientSource = protectClient ? () => protectClient : getProtectClient;
    const restored = this.restoreState();
    this.state = restored.state;
    this.resumeTimer(restored.timerEndsAt);
  }

  private restoreState(): RestoredState {
    let row: AlarmStateRow | undefined;
    try {
      row = this.db
        .prepare("SELECT name, since, triggered_by_sensor_id, timer_ends_at FROM alarm_state WHERE id = 1")
        .get() as AlarmStateRow | undefined;
    } catch (err) {
      logger.error({ err }, "failed to read alarm_state");
    }

    if (row && isValidStateName(row.name)) {
      const since = Date.parse(row.since);
      const timerEndsAt = row.timer_ends_at ? Date.parse(row.timer_ends_at) : NaN;
      return {
        state: {
          name: row.name,
          since: Number.isNaN(since) ? Date.now() : since,
          triggeredBy: row.triggered_by_sensor_id ? { sensorId: row.triggered_by_sensor_id } : undefined,
        },
        timerEndsAt: Number.isNaN(timerEndsAt) ? null : timerEndsAt,
      };
    }

    const fallback: AlarmState = { name: "DISARMED", since: Date.now() };
    recordAudit(this.db, row ? "panel_recovered_default_disarmed" : "initial_boot_disarmed");
    this.persistState(fallback);
    return { state: fallback, timerEndsAt: null };
  }

  /**
   * Re-arms the exit/entry countdown after a restart. The state name survives
   * in SQLite but the setTimeout driving it does not, so without this a reboot
   * (or the auto-updater restarting the service) mid-countdown left the system
   * wedged: ENTRY_DELAY never escalating to ALARM while someone is inside, or
   * ARMING never settling to ARMED. Reproduced live before this existed.
   */
  private resumeTimer(timerEndsAt: number | null): void {
    const elapsedType =
      this.state.name === "ARMING"
        ? "EXIT_DELAY_ELAPSED"
        : this.state.name === "ENTRY_DELAY"
          ? "ENTRY_DELAY_ELAPSED"
          : null;
    if (!elapsedType) return;

    // No persisted deadline (a DB written before migration 7, or a failed
    // write): reconstruct it from `since` + the configured delay, which is the
    // best available approximation.
    const { exitDelaySec, entryDelaySec } = getDelays(this.db);
    const fallbackMs = (elapsedType === "EXIT_DELAY_ELAPSED" ? exitDelaySec : entryDelaySec) * 1000;
    const endsAt = timerEndsAt ?? this.state.since + fallbackMs;
    // Already due while the process was down: 0ms fires on the next tick
    // rather than synchronously, so the constructor finishes first.
    this.armTimer(Math.max(0, endsAt - Date.now()), elapsedType);
    logger.warn(
      { state: this.state.name, resumesInMs: Math.max(0, endsAt - Date.now()) },
      "resumed an in-flight alarm countdown after a restart",
    );
  }

  /**
   * Restart-recovery only — never allowed to throw. A failed write (full disk,
   * locked DB) must not stop the timers and alerts from running: losing the
   * ability to recover state across a restart is bad, but a disk problem
   * silently disarming the office is far worse.
   */
  private persistState(state: AlarmState): void {
    try {
      this.db
        .prepare(
          `INSERT INTO alarm_state (id, name, since, triggered_by_sensor_id, timer_ends_at) VALUES (1, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name,
             since = excluded.since,
             triggered_by_sensor_id = excluded.triggered_by_sensor_id,
             timer_ends_at = excluded.timer_ends_at`,
        )
        .run(
          state.name,
          new Date(state.since).toISOString(),
          state.triggeredBy?.sensorId ?? null,
          this.timerEndsAt === null ? null : new Date(this.timerEndsAt).toISOString(),
        );
    } catch (err) {
      logger.error({ err, state: state.name }, "failed to persist alarm_state — continuing in memory");
    }
  }

  /**
   * configOverride lets syncExternalArmState() substitute a short sync-buffer
   * delay for the normal exitDelaySec on a UniFi-triggered arm (see its own
   * comment) — every other caller just uses the configured delays.
   */
  private dispatch(event: AlarmEvent, actorLabel?: string, configOverride?: TransitionConfig): void {
    const config = configOverride ?? getDelays(this.db);
    const result = transition(this.state, event, config);
    this.state = result.state;
    for (const effect of result.effects) {
      // Each effect is isolated: an audit write failing (full disk, locked DB)
      // must not stop START_ENTRY_TIMER or ALERT_ALARM further down the list
      // from running. The alarm firing matters more than the record of it.
      try {
        this.applyEffect(effect, event, actorLabel);
      } catch (err) {
        logger.error({ err, effect: effect.type }, "alarm effect failed");
      }
    }
    // After the effects, so the deadline just set by START_EXIT_TIMER /
    // START_ENTRY_TIMER is captured — that's what lets resumeTimer() pick a
    // countdown back up across a restart.
    this.persistState(this.state);
  }

  private applyEffect(effect: Effect, event: AlarmEvent, actorLabel?: string): void {
    if (effect.type !== "AUDIT") {
      this.runEffect(effect);
      return;
    }

    recordAudit(this.db, effect.event, { actorLabel, detail: effect.detail });
    // A duress disarm fires this same "disarmed" event with the same
    // actorLabel — the kiosk welcome stays identical either way, which
    // is the whole point of duress being visibly indistinguishable.
    // Excludes the Protect sync's own actor: "Welcome, UniFi" on the
    // kiosk after a console-triggered disarm is a real bug this was
    // caught producing live, not a person the kiosk should greet.
    if (effect.event === "arming_started") {
      this.armedInfo = { by: actorLabel ?? "Unknown", at: Date.now() };
    } else if (effect.event === "disarmed") {
      this.armedInfo = null;
    }
    if (effect.event === "disarmed" && actorLabel && !NON_PERSON_ACTORS.has(actorLabel)) {
      this.lastDisarmedBy = { firstName: actorLabel.split(" ")[0], at: Date.now() };
    }
    // A new exit delay always starts this count fresh; only a door
    // sensor's trip during it counts toward the panel's exit-delay
    // chime (a motion sensor picking up the person leaving shouldn't).
    if (effect.event === "arming_started") {
      this.armingTripCount = 0;
      this.armingTripDoors = [];
    } else if (effect.event === "sensor_trip_while_arming" && event.type === "SENSOR_TRIP") {
      const sensor = getSensor(this.db, event.sensorId);
      if (sensor?.sensorType === "door") {
        this.armingTripCount += 1;
        this.armingTripDoors = [...this.armingTripDoors.filter((n) => n !== sensor.name), sensor.name];
      }
    }
  }

  private runEffect(effect: Exclude<Effect, { type: "AUDIT" }>): void {
    switch (effect.type) {
      case "START_EXIT_TIMER":
        this.armTimer(effect.ms, "EXIT_DELAY_ELAPSED");
        break;
      case "START_ENTRY_TIMER":
        this.armTimer(effect.ms, "ENTRY_DELAY_ELAPSED");
        break;
      case "CANCEL_TIMERS":
        this.clearTimer();
        break;
      case "ALERT_ALARM":
        logger.warn({ sensorId: effect.sensorId }, "ALARM triggered");
        // Fire-and-forget: a Slack/ntfy/Protect outage must never block the state machine.
        void this.alertWithSnapshot("ALARM", effect.sensorId).catch((err) =>
          logger.error({ err }, "notifier threw"),
        );
        this.triggerSiren();
        break;
      case "ALERT_DURESS":
        logger.warn("duress disarm");
        void this.notifierSource()
          .send({ kind: "DURESS", at: new Date().toISOString() })
          .catch((err) => logger.error({ err }, "notifier threw"));
        break;
    }
  }

  /**
   * Best-effort: a camera lookup or snapshot failure must still result in
   * an alert going out, just without the image attached.
   */
  private async alertWithSnapshot(kind: "ALARM", sensorId?: string): Promise<void> {
    // Falls back to the default camera setting when the tripped sensor has no
    // camera of its own mapped yet, so an alert still carries a feed instead
    // of going out as bare text (dev: point it at protect:mock's fake camera).
    const cameraId = (sensorId ? getSensor(this.db, sensorId)?.cameraId : null) ?? getSetting("protectDefaultCameraId", this.db);
    const snapshot = cameraId ? await this.protectClientSource().getSnapshot(cameraId) : null;
    const liveViewUrl = cameraId ? this.protectClientSource().getLiveViewUrl(cameraId) : null;
    await this.notifierSource().send({
      kind,
      sensorId,
      at: new Date().toISOString(),
      snapshot,
      liveViewUrl,
    });
  }

  /**
   * Opt-in and off by default: unset sirenAlarmManagerWebhookId (see
   * /api/admin/config) means this is a no-op, since most deploys have no
   * siren hardware. Deliberately only called from the ALARM path, never
   * from ALERT_DURESS above — an audible siren would defeat the entire
   * point of a duress disarm looking exactly like a normal one.
   */
  private triggerSiren(): void {
    const webhookId = getConfigValue(this.db, "sirenAlarmManagerWebhookId");
    if (!webhookId) return;
    void this.protectClientSource().triggerAlarmManagerWebhook(webhookId).catch((err) => logger.error({ err }, "siren trigger threw"));
  }

  private armTimer(ms: number, elapsedType: "EXIT_DELAY_ELAPSED" | "ENTRY_DELAY_ELAPSED"): void {
    this.clearTimer();
    this.timerEndsAt = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.timerEndsAt = null;
      this.dispatch({ type: elapsedType, now: Date.now() });
    }, ms);
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.timerEndsAt = null;
  }

  /**
   * Doors gating arming right now (see lib/services/sensors.ts's
   * listOpenGatingSensors) — checked by both arm() and armWithoutPin(), but
   * deliberately NOT by syncExternalArmState(): that mirrors UniFi's actual
   * arm state, and refusing to mirror reality because this app's own
   * door-closed opinion disagrees would desync it, the exact failure mode
   * the sync feature exists to prevent.
   */
  private getOpenGatingSensors(): OpenSensor[] {
    return listOpenGatingSensors(this.db);
  }

  async arm(pin: string, rateLimitKey = "unknown", force = false): Promise<ArmResult> {
    return serializePinAttempt(() => this.armAttempt(pin, rateLimitKey, force));
  }

  private async armAttempt(pin: string, rateLimitKey: string, force: boolean): Promise<ArmResult> {
    const bucket = pinBucket(rateLimitKey);
    if (isLockedOut(bucket)) {
      recordAudit(this.db, "arm_locked_out", { detail: { source: rateLimitKey } });
      return { ok: false, lockedOut: true };
    }
    const verified = await verifyPin(this.db, pin);
    if (!verified.ok) {
      recordFailure(bucket);
      recordAudit(this.db, "arm_failed_invalid_pin", { detail: { source: rateLimitKey } });
      return { ok: false };
    }
    recordSuccess(bucket);

    const openSensors = this.getOpenGatingSensors();
    if (openSensors.length > 0) {
      if (!force) {
        recordAudit(this.db, "arm_rejected_sensors_open", { actorLabel: verified.label, detail: { source: rateLimitKey, sensors: openSensors } });
        return { ok: false, reason: "sensors_open", openSensors };
      }
      recordAudit(this.db, "arm_forced_with_sensors_open", { actorLabel: verified.label, detail: { source: rateLimitKey, sensors: openSensors } });
    }

    this.dispatch({ type: "ARM", now: Date.now() }, verified.label);
    return { ok: true };
  }

  /**
   * Arming from the panel (actorLabel "Panel") or the admin UI (actorLabel
   * "Admin") doesn't take a PIN — only disarming is a security boundary
   * worth gating (see /api/panel/arm, /api/admin/arm). No PIN means no
   * brute-force surface, so unlike arm()/disarm() this skips rate-limiting
   * entirely and always succeeds unless a gating door sensor is open.
   */
  armWithoutPin(actorLabel: string, force = false): ArmResult {
    const openSensors = this.getOpenGatingSensors();
    if (openSensors.length > 0) {
      if (!force) {
        recordAudit(this.db, "arm_rejected_sensors_open", { actorLabel, detail: { sensors: openSensors } });
        return { ok: false, reason: "sensors_open", openSensors };
      }
      recordAudit(this.db, "arm_forced_with_sensors_open", { actorLabel, detail: { sensors: openSensors } });
    }

    this.dispatch({ type: "ARM", now: Date.now() }, actorLabel);
    return { ok: true };
  }

  /**
   * Mirrors UniFi's own Alarm Manager arm state into this engine — see
   * lib/services/protect-alarm-sync.ts (the poller that calls this) and
   * README's "UniFi's own arm/disarm state can't be synced" section for the
   * two dead ends ruled out before this worked. Only dispatches on a real
   * edge (disarmed <-> armed-ish), never on every poll tick, so a sustained
   * armed state doesn't spam the audit log the way a naive repeated
   * dispatch(ARM) would (handleArmed's "arm_ignored_already_armed" fires on
   * every call, not just the first).
   *
   * `remoteArmed` is a caller-reduced boolean, not UniFi's raw profile
   * state string — the engine shouldn't need to know UniFi's vocabulary.
   * The caller treats a UniFi "breached" profile as armed (never as
   * disarmed — collapsing a breach to "not armed" would be the dangerous
   * direction for a security tool), but this method deliberately never
   * forces this engine into its own ALARM state: a real trip already
   * reaches ALARM through the ordinary sensor webhook path, and forcing it
   * again from this second, less-trusted signal only adds a spurious-alarm
   * risk without covering anything that path doesn't already cover for any
   * of this app's own physical sensors. A UniFi-only detection (e.g. an
   * AI camera event with no mapped sensor here) currently only reaches this
   * engine as "the system is armed" — visible in the panel/audit, not (yet)
   * an alert of its own.
   *
   * The caller also deliberately does NOT treat UniFi's own "arming" profile
   * state (its own exit delay, still counting down) as remoteArmed=true —
   * only a settled "armed"/"breached" reaches here. That means by the time
   * this fires, the real exit grace period already happened on UniFi's
   * side, so the ARM dispatched below uses getExternalArmSyncDelaySec()
   * (a short buffer for poll-interval/clock skew) instead of the normal,
   * full exitDelaySec — re-running the full local delay would otherwise
   * double the wait past what UniFi's own user already experienced, and
   * worse, leave this app showing "arming" (not yet protected) for up to a
   * full exitDelaySec after the office is actually armed on UniFi's side.
   */
  syncExternalArmState(remoteArmed: boolean, actorLabel: string = PROTECT_SYNC_ACTOR): void {
    const currentlyDisarmed = this.state.name === "DISARMED";
    if (remoteArmed && currentlyDisarmed) {
      const { entryDelaySec } = getDelays(this.db);
      const exitDelaySec = getExternalArmSyncDelaySec(this.db);
      this.dispatch({ type: "ARM", now: Date.now() }, actorLabel, { exitDelaySec, entryDelaySec });
    } else if (!remoteArmed && !currentlyDisarmed) {
      this.dispatch({ type: "DISARM", now: Date.now(), duress: false }, actorLabel);
    }
  }

  async disarm(pin: string, rateLimitKey = "unknown"): Promise<DisarmResult> {
    return serializePinAttempt(() => this.disarmAttempt(pin, rateLimitKey));
  }

  private async disarmAttempt(pin: string, rateLimitKey: string): Promise<DisarmResult> {
    const bucket = pinBucket(rateLimitKey);
    if (isLockedOut(bucket)) {
      recordAudit(this.db, "disarm_locked_out", { detail: { source: rateLimitKey } });
      return { ok: false, lockedOut: true };
    }
    const verified = await verifyPin(this.db, pin);
    if (!verified.ok) {
      recordFailure(bucket);
      recordAudit(this.db, "disarm_failed_invalid_pin", { detail: { source: rateLimitKey } });
      // This failure may have just tipped the bucket over into lockout —
      // treat repeated wrong PINs at the physical keypad as a live
      // intrusion attempt, not just a UI nuisance to throttle quietly (see
      // handlePinLockout in lib/state/machine.ts).
      if (isLockedOut(bucket)) {
        this.dispatch({ type: "PIN_LOCKOUT", now: Date.now(), source: rateLimitKey });
        return { ok: false, lockedOut: true };
      }
      return { ok: false, remainingAttempts: getRemainingAttempts(bucket) };
    }
    recordSuccess(bucket);
    this.dispatch({ type: "DISARM", now: Date.now(), duress: verified.isDuress ?? false }, verified.label);
    return { ok: true };
  }

  handleSensorTrip(sensorId: string, mode: SensorMode): void {
    this.dispatch({ type: "SENSOR_TRIP", now: Date.now(), sensorId, mode });
  }

  /**
   * Drops the in-flight countdown's timer without touching the persisted
   * state — exactly what a process exit does. Used by the tests to simulate a
   * restart against the same DB (see "resuming a countdown after a restart");
   * the persisted deadline is what a fresh instance picks back up.
   */
  stopForTest(): void {
    this.clearTimer();
  }

  getStatus(): EngineStatus {
    const remainingSec = this.timerEndsAt
      ? Math.max(0, Math.ceil((this.timerEndsAt - Date.now()) / 1000))
      : null;
    // Only while actually disarmed, and only within the window — re-arming
    // (even immediately) or the window lapsing both clear it, so the kiosk
    // never shows a stale welcome for whoever's there now.
    const welcomeName =
      this.state.name === "DISARMED" && this.lastDisarmedBy && Date.now() - this.lastDisarmedBy.at < WELCOME_WINDOW_MS
        ? this.lastDisarmedBy.firstName
        : null;
    return {
      state: this.state.name,
      since: new Date(this.state.since).toISOString(),
      remainingSec,
      welcomeName,
      triggeredBy: this.state.triggeredBy ?? null,
      triggeredByName: this.state.triggeredBy ? (getSensor(this.db, this.state.triggeredBy.sensorId)?.name ?? null) : null,
      armingTripCount: this.state.name === "ARMING" ? this.armingTripCount : null,
      armingTripDoors: this.state.name === "ARMING" ? this.armingTripDoors : null,
      doors: listDoorStatuses(this.db),
      armedBy: this.state.name === "DISARMED" ? null : (this.armedInfo?.by ?? null),
      armedAt: this.state.name === "DISARMED" ? null : (this.armedInfo?.at ?? null),
      testMode: isPanelTestMode(this.db),
    };
  }
}

// See the matching comment in lib/db/index.ts: this must live on globalThis,
// not a module-scoped `let`, or each Next-compiled route bundle ends up with
// its own independent engine (own timers, own in-memory state) instead of
// the single process-wide instance this whole design depends on.
declare global {
  var __uapEngine: AlarmEngine | undefined;
}

export function getEngine(): AlarmEngine {
  if (!globalThis.__uapEngine) {
    globalThis.__uapEngine = new AlarmEngine(getDb());
  }
  return globalThis.__uapEngine;
}
