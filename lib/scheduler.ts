import { logger } from "@/lib/logger";

export interface ScheduledJob {
  name: string;
  intervalMs: number;
  run: () => Promise<void> | void;
}

/**
 * Minimal named-interval job runner for background system tasks (update
 * checks, connectivity watchdog) — separate from AlarmEngine's timer, which
 * is single-purpose (the alarm state machine's own exit/entry delay).
 */
export function startScheduler(jobs: ScheduledJob[]): () => void {
  const timers: NodeJS.Timeout[] = [];
  for (const job of jobs) {
    // One run at a time per job: a slow run (network timeouts) must not overlap the next tick, or an older poll can finish after a newer one and apply a stale reading.
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try {
        await job.run();
      } catch (err) {
        logger.error({ err, job: job.name }, "scheduled job threw");
      } finally {
        running = false;
      }
    };
    void tick();
    timers.push(setInterval(() => void tick(), job.intervalMs));
  }
  return () => timers.forEach(clearInterval);
}
