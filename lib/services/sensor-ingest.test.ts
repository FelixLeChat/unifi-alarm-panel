import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlarmEngine } from "@/lib/engine";
import { ingestSensorTrip, resetTripDedupe } from "./sensor-ingest";

const handleSensorTrip = vi.fn();
const engine = { handleSensorTrip } as unknown as AlarmEngine;

beforeEach(() => {
  handleSensorTrip.mockReset();
  resetTripDedupe();
  vi.useRealTimers();
});

describe("ingestSensorTrip", () => {
  // The two sources describe the same physical door opening. The engine
  // must act on it once — a second ARM-state trip is at best a duplicate
  // audit row and at worst a second alarm.
  it("drops the second source's copy of the same trip", () => {
    expect(ingestSensorTrip(engine, "58D61F49A73B", "instant", "webhook")).toBe(true);
    expect(ingestSensorTrip(engine, "58D61F49A73B", "instant", "stream")).toBe(false);
    expect(handleSensorTrip).toHaveBeenCalledTimes(1);
  });

  // Deliberately one-way: de-duplication is only across sources. A motion
  // sensor reporting every few seconds through one source is reporting real,
  // separate events, and behaved this way before a second source existed.
  it("keeps repeated trips from the same source", () => {
    expect(ingestSensorTrip(engine, "58D61F49A73B", "instant", "webhook")).toBe(true);
    expect(ingestSensorTrip(engine, "58D61F49A73B", "instant", "webhook")).toBe(true);
    expect(handleSensorTrip).toHaveBeenCalledTimes(2);
  });

  it("keeps trips from different sensors, however close together", () => {
    expect(ingestSensorTrip(engine, "58D61F49A73B", "instant", "webhook")).toBe(true);
    expect(ingestSensorTrip(engine, "58D61F49A715", "instant", "stream")).toBe(true);
    expect(handleSensorTrip).toHaveBeenCalledTimes(2);
  });

  it("stops suppressing once the window has passed", () => {
    vi.useFakeTimers();
    ingestSensorTrip(engine, "58D61F49A73B", "instant", "webhook");
    vi.advanceTimersByTime(6_000);
    expect(ingestSensorTrip(engine, "58D61F49A73B", "instant", "stream")).toBe(true);
    expect(handleSensorTrip).toHaveBeenCalledTimes(2);
  });
});
