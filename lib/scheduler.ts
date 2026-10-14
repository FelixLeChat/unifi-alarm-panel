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
export function startScheduler(jobs: ScheduledJob[]): void {
  for (const job of jobs) {
    const tick = async () => {
      try {
        await job.run();
      } catch (err) {
        logger.error({ err, job: job.name }, "scheduled job threw");
      }
    };
    void tick();
    setInterval(tick, job.intervalMs);
  }
}
