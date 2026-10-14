export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getEngine } = await import("@/lib/engine");
    getEngine();

    const { getDb } = await import("@/lib/db");
    const { resyncGo2rtcStreams } = await import("@/lib/services/go2rtc-client");
    void resyncGo2rtcStreams(getDb());

    // Long-lived WebSocket, the second sensor-event source (see
    // lib/services/protect-event-stream.ts). Its job only (re)connects it
    // when the console settings change; a no-op without the SuperAdmin
    // credential, same as the arm-state sync.
    const { protectEventStreamJob } = await import("@/lib/services/protect-event-stream");

    const { startScheduler } = await import("@/lib/scheduler");
    const { checkUpdateJob } = await import("@/lib/services/update-check");
    const { connectivityWatchdogJob } = await import("@/lib/services/connectivity-watchdog");
    const { auditArchiveJob } = await import("@/lib/services/audit-archive");
    const { dbBackupJob } = await import("@/lib/services/db-backup");
    const { protectAlarmSyncJob } = await import("@/lib/services/protect-alarm-sync");
    const { protectDeviceHealthJob } = await import("@/lib/services/protect-device-health");
    startScheduler([
      protectEventStreamJob({ db: getDb(), engine: getEngine() }),
      checkUpdateJob,
      connectivityWatchdogJob,
      auditArchiveJob,
      dbBackupJob,
      protectAlarmSyncJob,
      protectDeviceHealthJob,
    ]);
  }
}
