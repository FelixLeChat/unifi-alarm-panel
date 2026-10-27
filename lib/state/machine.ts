/**
 * Pure alarm state machine. No wall clock, no I/O, no timers.
 * `now` and delay config are passed in by the caller (lib/engine); this
 * module only ever reduces (state, event, config) -> (state, effects).
 */

export type AlarmStateName = "DISARMED" | "ARMING" | "ARMED" | "ENTRY_DELAY" | "ALARM";

export type SensorMode = "delayed" | "instant" | "ignore";

export interface AlarmState {
  name: AlarmStateName;
  since: number;
  triggeredBy?: { sensorId: string };
}

export type AlarmEvent =
  | { type: "ARM"; now: number }
  | { type: "EXIT_DELAY_ELAPSED"; now: number }
  | { type: "ENTRY_DELAY_ELAPSED"; now: number }
  | { type: "DISARM"; now: number; duress: boolean }
  | { type: "SENSOR_TRIP"; now: number; sensorId: string; mode: SensorMode }
  | { type: "PIN_LOCKOUT"; now: number; source: string };

export type Effect =
  | { type: "START_EXIT_TIMER"; ms: number }
  | { type: "START_ENTRY_TIMER"; ms: number }
  | { type: "CANCEL_TIMERS" }
  | { type: "ALERT_ALARM"; sensorId?: string }
  | { type: "ALERT_DURESS" }
  | { type: "AUDIT"; event: string; detail?: Record<string, unknown> };

export interface TransitionConfig {
  exitDelaySec: number;
  entryDelaySec: number;
}

export interface TransitionResult {
  state: AlarmState;
  effects: Effect[];
}

export function transition(state: AlarmState, event: AlarmEvent, config: TransitionConfig): TransitionResult {
  if (event.type === "DISARM") {
    return handleDisarm(state, event);
  }
  if (event.type === "PIN_LOCKOUT") {
    return handlePinLockout(state, event);
  }

  switch (state.name) {
    case "DISARMED":
      return handleDisarmed(state, event, config);
    case "ARMING":
      return handleArming(state, event);
    case "ARMED":
      return handleArmed(state, event, config);
    case "ENTRY_DELAY":
      return handleEntryDelay(state, event);
    case "ALARM":
      return handleAlarm(state, event);
  }
}

function handleDisarm(state: AlarmState, event: Extract<AlarmEvent, { type: "DISARM" }>): TransitionResult {
  const effects: Effect[] = [];
  if (event.duress) {
    effects.push({ type: "ALERT_DURESS" });
  }

  if (state.name === "DISARMED") {
    effects.push({ type: "AUDIT", event: "disarm_while_disarmed" });
    return { state, effects };
  }

  effects.push({ type: "CANCEL_TIMERS" });
  effects.push({ type: "AUDIT", event: "disarmed", detail: { from: state.name } });
  return { state: { name: "DISARMED", since: event.now }, effects };
}

/**
 * Handled the same way regardless of current state, same precedent as
 * handleDisarm above — deliberately the opposite call from a sensor trip
 * while disarmed ("log only, no alert": a quiet office tripping its own
 * motion sensor is normal). Repeated wrong PINs at the physical keypad
 * aren't: that's the one signal here that means someone is actively trying
 * to get in, whether or not the system happened to be armed at the time.
 */
function handlePinLockout(state: AlarmState, event: Extract<AlarmEvent, { type: "PIN_LOCKOUT" }>): TransitionResult {
  if (state.name === "ALARM") {
    return { state, effects: [{ type: "AUDIT", event: "pin_lockout_during_alarm", detail: { source: event.source } }] };
  }
  return {
    state: { name: "ALARM", since: event.now },
    effects: [
      // ARMING or ENTRY_DELAY may have a countdown running: drop it, or it fires into ALARM as a stale timer and the panel keeps showing it.
      { type: "CANCEL_TIMERS" },
      { type: "ALERT_ALARM" },
      { type: "AUDIT", event: "alarm_pin_lockout", detail: { source: event.source, from: state.name } },
    ],
  };
}

function handleDisarmed(state: AlarmState, event: AlarmEvent, config: TransitionConfig): TransitionResult {
  switch (event.type) {
    case "ARM":
      return {
        state: { name: "ARMING", since: event.now },
        effects: [
          { type: "START_EXIT_TIMER", ms: config.exitDelaySec * 1000 },
          { type: "AUDIT", event: "arming_started" },
        ],
      };
    case "SENSOR_TRIP":
      // The single most important rule: disarmed sensor trips are logged only. No alert, no noise.
      return {
        state,
        effects: [
          {
            type: "AUDIT",
            event: "sensor_trip_while_disarmed",
            detail: { sensorId: event.sensorId, mode: event.mode },
          },
        ],
      };
    case "EXIT_DELAY_ELAPSED":
    case "ENTRY_DELAY_ELAPSED":
      return {
        state,
        effects: [{ type: "AUDIT", event: "stale_timer_ignored", detail: { eventType: event.type } }],
      };
    default:
      return { state, effects: [] };
  }
}

function handleArming(state: AlarmState, event: AlarmEvent): TransitionResult {
  switch (event.type) {
    case "EXIT_DELAY_ELAPSED":
      return { state: { name: "ARMED", since: event.now }, effects: [{ type: "AUDIT", event: "armed" }] };
    case "SENSOR_TRIP":
      // Grace period while leaving: log, don't alarm.
      return {
        state,
        effects: [
          {
            type: "AUDIT",
            event: "sensor_trip_while_arming",
            detail: { sensorId: event.sensorId, mode: event.mode },
          },
        ],
      };
    case "ARM":
      return { state, effects: [{ type: "AUDIT", event: "arm_ignored_already_arming" }] };
    case "ENTRY_DELAY_ELAPSED":
      return {
        state,
        effects: [{ type: "AUDIT", event: "stale_timer_ignored", detail: { eventType: event.type } }],
      };
    default:
      return { state, effects: [] };
  }
}

function handleArmed(state: AlarmState, event: AlarmEvent, config: TransitionConfig): TransitionResult {
  switch (event.type) {
    case "SENSOR_TRIP":
      if (event.mode === "instant") {
        return {
          state: { name: "ALARM", since: event.now, triggeredBy: { sensorId: event.sensorId } },
          effects: [
            { type: "ALERT_ALARM", sensorId: event.sensorId },
            { type: "AUDIT", event: "alarm_instant", detail: { sensorId: event.sensorId } },
          ],
        };
      }
      if (event.mode === "delayed") {
        return {
          state: { name: "ENTRY_DELAY", since: event.now, triggeredBy: { sensorId: event.sensorId } },
          effects: [
            { type: "START_ENTRY_TIMER", ms: config.entryDelaySec * 1000 },
            { type: "AUDIT", event: "entry_delay_started", detail: { sensorId: event.sensorId } },
          ],
        };
      }
      return {
        state,
        effects: [{ type: "AUDIT", event: "sensor_trip_ignored_mode", detail: { sensorId: event.sensorId } }],
      };
    case "ARM":
      return { state, effects: [{ type: "AUDIT", event: "arm_ignored_already_armed" }] };
    case "EXIT_DELAY_ELAPSED":
    case "ENTRY_DELAY_ELAPSED":
      return {
        state,
        effects: [{ type: "AUDIT", event: "stale_timer_ignored", detail: { eventType: event.type } }],
      };
    default:
      return { state, effects: [] };
  }
}

function handleEntryDelay(state: AlarmState, event: AlarmEvent): TransitionResult {
  switch (event.type) {
    case "ENTRY_DELAY_ELAPSED":
      return {
        state: { name: "ALARM", since: event.now, triggeredBy: state.triggeredBy },
        effects: [
          { type: "ALERT_ALARM", sensorId: state.triggeredBy?.sensorId },
          {
            type: "AUDIT",
            event: "alarm_entry_timeout",
            detail: { sensorId: state.triggeredBy?.sensorId },
          },
        ],
      };
    case "SENSOR_TRIP":
      if (event.mode === "instant") {
        return {
          state: { name: "ALARM", since: event.now, triggeredBy: { sensorId: event.sensorId } },
          effects: [
            { type: "CANCEL_TIMERS" },
            { type: "ALERT_ALARM", sensorId: event.sensorId },
            {
              type: "AUDIT",
              event: "alarm_instant_during_entry_delay",
              detail: { sensorId: event.sensorId },
            },
          ],
        };
      }
      return {
        state,
        effects: [
          {
            type: "AUDIT",
            event: "sensor_trip_during_entry_delay",
            detail: { sensorId: event.sensorId, mode: event.mode },
          },
        ],
      };
    case "ARM":
      return { state, effects: [{ type: "AUDIT", event: "arm_ignored_entry_delay" }] };
    case "EXIT_DELAY_ELAPSED":
      return {
        state,
        effects: [{ type: "AUDIT", event: "stale_timer_ignored", detail: { eventType: event.type } }],
      };
    default:
      return { state, effects: [] };
  }
}

function handleAlarm(state: AlarmState, event: AlarmEvent): TransitionResult {
  switch (event.type) {
    case "SENSOR_TRIP":
      return {
        state,
        effects: [
          {
            type: "AUDIT",
            event: "sensor_trip_during_alarm",
            detail: { sensorId: event.sensorId, mode: event.mode },
          },
        ],
      };
    case "ARM":
      return { state, effects: [{ type: "AUDIT", event: "arm_ignored_during_alarm" }] };
    case "EXIT_DELAY_ELAPSED":
    case "ENTRY_DELAY_ELAPSED":
      return {
        state,
        effects: [{ type: "AUDIT", event: "stale_timer_ignored", detail: { eventType: event.type } }],
      };
    default:
      return { state, effects: [] };
  }
}
