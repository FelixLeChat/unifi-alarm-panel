import { describe, expect, it } from "vitest";
import { transition, type AlarmState } from "./machine";

const config = { exitDelaySec: 30, entryDelaySec: 45 };

const disarmed = (since = 0): AlarmState => ({ name: "DISARMED", since });
const arming = (since = 0): AlarmState => ({ name: "ARMING", since });
const armed = (since = 0): AlarmState => ({ name: "ARMED", since });
const entryDelay = (sensorId: string, since = 0): AlarmState => ({
  name: "ENTRY_DELAY",
  since,
  triggeredBy: { sensorId },
});
const alarm = (sensorId: string, since = 0): AlarmState => ({
  name: "ALARM",
  since,
  triggeredBy: { sensorId },
});

describe("DISARMED", () => {
  it("ARM -> ARMING and starts the exit timer", () => {
    const result = transition(disarmed(), { type: "ARM", now: 100 }, config);
    expect(result.state).toEqual({ name: "ARMING", since: 100 });
    expect(result.effects).toContainEqual({ type: "START_EXIT_TIMER", ms: 30_000 });
  });

  it("sensor trips are logged only, never alerted", () => {
    const result = transition(
      disarmed(),
      { type: "SENSOR_TRIP", now: 100, sensorId: "s1", mode: "instant" },
      config,
    );
    expect(result.state.name).toBe("DISARMED");
    expect(result.effects).not.toContainEqual(expect.objectContaining({ type: "ALERT_ALARM" }));
    expect(result.effects).toContainEqual(
      expect.objectContaining({ type: "AUDIT", event: "sensor_trip_while_disarmed" }),
    );
  });

  it("disarming while already disarmed is a no-op audit", () => {
    const result = transition(disarmed(), { type: "DISARM", now: 100, duress: false }, config);
    expect(result.state).toEqual(disarmed());
    expect(result.effects).toEqual([{ type: "AUDIT", event: "disarm_while_disarmed" }]);
  });
});

describe("ARMING (exit delay)", () => {
  it("EXIT_DELAY_ELAPSED -> ARMED", () => {
    const result = transition(arming(0), { type: "EXIT_DELAY_ELAPSED", now: 30_000 }, config);
    expect(result.state).toEqual({ name: "ARMED", since: 30_000 });
    expect(result.effects).toContainEqual({ type: "AUDIT", event: "armed" });
  });

  it("sensor trips during exit delay are logged only", () => {
    const result = transition(
      arming(),
      { type: "SENSOR_TRIP", now: 10, sensorId: "s1", mode: "instant" },
      config,
    );
    expect(result.state.name).toBe("ARMING");
    expect(result.effects).not.toContainEqual(expect.objectContaining({ type: "ALERT_ALARM" }));
  });

  it("DISARM cancels the exit timer", () => {
    const result = transition(arming(), { type: "DISARM", now: 10, duress: false }, config);
    expect(result.state).toEqual({ name: "DISARMED", since: 10 });
    expect(result.effects).toContainEqual({ type: "CANCEL_TIMERS" });
  });
});

describe("ARMED", () => {
  it("instant sensor -> ALARM immediately", () => {
    const result = transition(
      armed(),
      { type: "SENSOR_TRIP", now: 500, sensorId: "back-door", mode: "instant" },
      config,
    );
    expect(result.state).toEqual({
      name: "ALARM",
      since: 500,
      triggeredBy: { sensorId: "back-door" },
    });
    expect(result.effects).toContainEqual({ type: "ALERT_ALARM", sensorId: "back-door" });
  });

  it("delayed sensor -> ENTRY_DELAY and starts the entry timer", () => {
    const result = transition(
      armed(),
      { type: "SENSOR_TRIP", now: 500, sensorId: "front-door", mode: "delayed" },
      config,
    );
    expect(result.state).toEqual({
      name: "ENTRY_DELAY",
      since: 500,
      triggeredBy: { sensorId: "front-door" },
    });
    expect(result.effects).toContainEqual({ type: "START_ENTRY_TIMER", ms: 45_000 });
  });

  it("ignore-mode sensor does nothing but audit", () => {
    const result = transition(
      armed(),
      { type: "SENSOR_TRIP", now: 500, sensorId: "s1", mode: "ignore" },
      config,
    );
    expect(result.state.name).toBe("ARMED");
    expect(result.effects).not.toContainEqual(expect.objectContaining({ type: "ALERT_ALARM" }));
  });

  it("DISARM -> DISARMED", () => {
    const result = transition(armed(), { type: "DISARM", now: 10, duress: false }, config);
    expect(result.state).toEqual({ name: "DISARMED", since: 10 });
  });
});

describe("ENTRY_DELAY", () => {
  it("ENTRY_DELAY_ELAPSED with no disarm -> ALARM", () => {
    const result = transition(
      entryDelay("front-door", 0),
      { type: "ENTRY_DELAY_ELAPSED", now: 45_000 },
      config,
    );
    expect(result.state).toEqual({
      name: "ALARM",
      since: 45_000,
      triggeredBy: { sensorId: "front-door" },
    });
    expect(result.effects).toContainEqual({ type: "ALERT_ALARM", sensorId: "front-door" });
  });

  it("valid DISARM cancels the entry timer before it elapses", () => {
    const result = transition(
      entryDelay("front-door", 0),
      { type: "DISARM", now: 20_000, duress: false },
      config,
    );
    expect(result.state).toEqual({ name: "DISARMED", since: 20_000 });
    expect(result.effects).toContainEqual({ type: "CANCEL_TIMERS" });
  });

  it("a second instant sensor trip escalates to ALARM immediately", () => {
    const result = transition(
      entryDelay("front-door", 0),
      { type: "SENSOR_TRIP", now: 5_000, sensorId: "motion-1", mode: "instant" },
      config,
    );
    expect(result.state.name).toBe("ALARM");
    expect(result.effects).toContainEqual({ type: "CANCEL_TIMERS" });
    expect(result.effects).toContainEqual({ type: "ALERT_ALARM", sensorId: "motion-1" });
  });
});

describe("ALARM", () => {
  it("DISARM silences the alarm", () => {
    const result = transition(alarm("front-door"), { type: "DISARM", now: 10, duress: false }, config);
    expect(result.state).toEqual({ name: "DISARMED", since: 10 });
  });

  it("further sensor trips don't spam new alerts", () => {
    const result = transition(
      alarm("front-door"),
      { type: "SENSOR_TRIP", now: 10, sensorId: "motion-1", mode: "instant" },
      config,
    );
    expect(result.state.name).toBe("ALARM");
    expect(result.effects).not.toContainEqual(expect.objectContaining({ type: "ALERT_ALARM" }));
  });
});

describe("PIN_LOCKOUT", () => {
  it("triggers ALARM from DISARMED — unlike a sensor trip, repeated wrong PINs are alarming on their own", () => {
    const result = transition(disarmed(), { type: "PIN_LOCKOUT", now: 100, source: "kiosk" }, config);
    expect(result.state).toEqual({ name: "ALARM", since: 100 });
    expect(result.effects).toContainEqual({ type: "ALERT_ALARM" });
    expect(result.effects).toContainEqual(
      expect.objectContaining({ type: "AUDIT", event: "alarm_pin_lockout", detail: { source: "kiosk", from: "DISARMED" } }),
    );
  });

  it("triggers ALARM from ARMED too", () => {
    const result = transition(armed(), { type: "PIN_LOCKOUT", now: 100, source: "kiosk" }, config);
    expect(result.state).toEqual({ name: "ALARM", since: 100 });
  });

  it.each([arming(), entryDelay("front-door")])("cancels the running countdown when it fires from %s", (state) => {
    const result = transition(state, { type: "PIN_LOCKOUT", now: 100, source: "kiosk" }, config);
    expect(result.state.name).toBe("ALARM");
    expect(result.effects).toContainEqual({ type: "CANCEL_TIMERS" });
  });

  it("doesn't spam a second alert if already in ALARM", () => {
    const result = transition(alarm("front-door"), { type: "PIN_LOCKOUT", now: 100, source: "kiosk" }, config);
    expect(result.state).toEqual(alarm("front-door"));
    expect(result.effects).not.toContainEqual(expect.objectContaining({ type: "ALERT_ALARM" }));
    expect(result.effects).toContainEqual(
      expect.objectContaining({ type: "AUDIT", event: "pin_lockout_during_alarm" }),
    );
  });
});

describe("duress", () => {
  it("fires ALERT_DURESS on top of a normal disarm from ARMED", () => {
    const result = transition(armed(), { type: "DISARM", now: 10, duress: true }, config);
    expect(result.state).toEqual({ name: "DISARMED", since: 10 });
    expect(result.effects).toContainEqual({ type: "ALERT_DURESS" });
  });

  it("fires ALERT_DURESS even when already disarmed", () => {
    const result = transition(disarmed(), { type: "DISARM", now: 10, duress: true }, config);
    expect(result.state.name).toBe("DISARMED");
    expect(result.effects).toContainEqual({ type: "ALERT_DURESS" });
  });

  it("duress disarm is indistinguishable in state from a normal disarm", () => {
    const normal = transition(armed(), { type: "DISARM", now: 10, duress: false }, config);
    const duress = transition(armed(), { type: "DISARM", now: 10, duress: true }, config);
    expect(duress.state).toEqual(normal.state);
  });
});

describe("timer invariant", () => {
  const states = [disarmed(), arming(), armed(), entryDelay("front-door"), alarm("front-door")];
  const events = [
    { type: "ARM" as const, now: 1 },
    { type: "DISARM" as const, now: 1, duress: false },
    { type: "PIN_LOCKOUT" as const, now: 1, source: "kiosk" },
    { type: "SENSOR_TRIP" as const, now: 1, sensorId: "s", mode: "instant" as const },
    { type: "SENSOR_TRIP" as const, now: 1, sensorId: "s", mode: "delayed" as const },
    { type: "EXIT_DELAY_ELAPSED" as const, now: 1 },
    { type: "ENTRY_DELAY_ELAPSED" as const, now: 1 },
  ];

  it("a transition that leaves ARMING or ENTRY_DELAY always cancels or replaces the countdown", () => {
    for (const state of states) {
      for (const event of events) {
        const result = transition(state, event, config);
        const timed = state.name === "ARMING" || state.name === "ENTRY_DELAY";
        // An ELAPSED event is the timer itself firing, so the engine has already dropped it.
        const leaves = timed && result.state.name !== state.name && !event.type.endsWith("_ELAPSED");
        const handled = result.effects.some((e) => ["CANCEL_TIMERS", "START_EXIT_TIMER", "START_ENTRY_TIMER"].includes(e.type));
        if (leaves) expect(handled, `${state.name} + ${event.type}`).toBe(true);
      }
    }
  });
});
