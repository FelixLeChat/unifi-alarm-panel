import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startScheduler } from "./scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startScheduler", () => {
  it("runs each job at once, then on its interval, and stop() ends it", async () => {
    const run = vi.fn(async () => {});
    const stop = startScheduler([{ name: "a", intervalMs: 1000, run }]);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2500);
    expect(run).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("skips a tick while the previous run of the same job is still pending", async () => {
    let release!: () => void;
    const run = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const stop = startScheduler([{ name: "slow", intervalMs: 100, run }]);
    await vi.advanceTimersByTimeAsync(350);
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    stop();
  });

  it("isolates a throwing job from the others", async () => {
    const bad = vi.fn(() => Promise.reject(new Error("boom")));
    const good = vi.fn(async () => {});
    const stop = startScheduler([
      { name: "bad", intervalMs: 100, run: bad },
      { name: "good", intervalMs: 100, run: good },
    ]);
    await vi.advanceTimersByTimeAsync(250);
    expect(bad).toHaveBeenCalledTimes(3);
    expect(good).toHaveBeenCalledTimes(3);
    stop();
  });
});
