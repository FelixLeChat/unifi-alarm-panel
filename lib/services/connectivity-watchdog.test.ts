import { beforeEach, describe, expect, it, vi } from "vitest";

const getLastWebhookAgeSec = vi.fn();
const hasEverReceivedWebhook = vi.fn(() => true);
const getLastEventSource = vi.fn<() => "webhook" | "stream" | null>(() => null);
vi.mock("@/lib/services/webhook-intake", () => ({
  getLastWebhookAgeSec: () => getLastWebhookAgeSec(),
  hasEverReceivedWebhook: () => hasEverReceivedWebhook(),
  getLastEventSource: () => getLastEventSource(),
}));

const getStreamStatus = vi.fn<() => { status: "disabled" | "connected" | "disconnected"; lastError: string | null; connectedAt: string | null }>(
  () => ({ status: "disabled", lastError: null, connectedAt: null }),
);
vi.mock("@/lib/services/protect-event-stream", () => ({ getStreamStatus: () => getStreamStatus() }));

type SentAlert = { kind: string; message?: string };
const send = vi.fn<(alert: SentAlert) => Promise<void>>(async () => {});
vi.mock("@/lib/services/notifiers", () => ({ getNotifier: () => ({ send }) }));

const checkDeviceHealth = vi.fn(async () => {});
vi.mock("@/lib/services/protect-device-health", () => ({
  checkDeviceHealth: () => checkDeviceHealth(),
  getDeviceHealthStatus: () => ({ devices: {}, checkedAt: null, error: null }),
}));

const getSnapshot = vi.fn();
vi.mock("@/lib/services/protect-client", () => ({ getProtectClient: () => ({ getSnapshot }) }));
const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/services/settings", () => ({ getSetting: (key: string) => settings.get(key) ?? null }));

describe("checkConnectivity", () => {
  beforeEach(() => {
    vi.resetModules();
    getLastWebhookAgeSec.mockReset();
    hasEverReceivedWebhook.mockReset();
    hasEverReceivedWebhook.mockReturnValue(true);
    getLastEventSource.mockReset();
    getLastEventSource.mockReturnValue(null);
    getStreamStatus.mockReset();
    getStreamStatus.mockReturnValue({ status: "disabled", lastError: null, connectedAt: null });
    send.mockReset();
    checkDeviceHealth.mockReset();
    getSnapshot.mockReset();
    delete globalThis.__uapConnectivityStatus;
  });

  it("flags the heartbeat stale past the threshold", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(3 * 60 * 60);
    const { checkConnectivity, getConnectivityStatus } = await import("./connectivity-watchdog");
    await checkConnectivity();
    expect(getConnectivityStatus().sensorHeartbeatStale).toBe(true);
  });

  it("leaves cameraReachable null when no default camera is configured", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(5);
    const { checkConnectivity, getConnectivityStatus } = await import("./connectivity-watchdog");
    await checkConnectivity();
    expect(getConnectivityStatus().cameraReachable).toBeNull();
    expect(getSnapshot).not.toHaveBeenCalled();
  });

  it("marks the camera unreachable when getSnapshot returns null", async () => {
    settings.set("protectDefaultCameraId", "cam-1");
    getLastWebhookAgeSec.mockReturnValue(5);
    getSnapshot.mockResolvedValue(null);
    const { checkConnectivity, getConnectivityStatus } = await import("./connectivity-watchdog");
    await checkConnectivity();
    expect(getConnectivityStatus().cameraReachable).toBe(false);
  });

  /**
   * The failure this whole thing exists for: the sensor feed was dead for
   * two days with a watchdog reporting healthy, because "no webhook ever
   * received" read as null and null read as fine. A quiet feed must alert,
   * not just log — and only on the edge, so a week-long outage doesn't
   * notify every five minutes.
   */
  it("notifies once on the edge into a stale heartbeat", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(3 * 60 * 60);
    const { checkConnectivity } = await import("./connectivity-watchdog");

    await checkConnectivity();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ kind: "HEALTH" });

    await checkConnectivity();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("says so explicitly when nothing has arrived since the process started", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(3 * 60 * 60);
    hasEverReceivedWebhook.mockReturnValue(false);
    const { checkConnectivity } = await import("./connectivity-watchdog");
    await checkConnectivity();
    expect(send.mock.calls[0][0].message).toContain("since this server started");
  });

  /**
   * Both sources feed the same heartbeat, so this alert used to say "the
   * webhook feed looks dead" even when the webhook was fine and only the
   * realtime stream had died — indistinguishable from an actually-quiet
   * office. Naming the stream's own state is what makes the alert
   * self-diagnosing instead of triggering another blind investigation.
   */
  it("does not notify when the stream is connected — a silent connected stream is a quiet office", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(3 * 60 * 60);
    getStreamStatus.mockReturnValue({ status: "connected", lastError: null, connectedAt: "2026-09-23T00:00:00.000Z" });
    const { checkConnectivity, getConnectivityStatus } = await import("./connectivity-watchdog");
    await checkConnectivity();
    expect(send).not.toHaveBeenCalled();
    expect(getConnectivityStatus().sensorHeartbeatStale).toBe(true);
  });

  it("still notifies if the stream drops during a silence that was not notified", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(3 * 60 * 60);
    getStreamStatus.mockReturnValue({ status: "connected", lastError: null, connectedAt: null });
    const { checkConnectivity } = await import("./connectivity-watchdog");
    await checkConnectivity();
    expect(send).not.toHaveBeenCalled();

    getStreamStatus.mockReturnValue({ status: "disconnected", lastError: "boom", connectedAt: null });
    await checkConnectivity();
    await checkConnectivity();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("names a disconnected stream in the alert", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(3 * 60 * 60);
    getStreamStatus.mockReturnValue({ status: "disconnected", lastError: "boom", connectedAt: null });
    const { checkConnectivity } = await import("./connectivity-watchdog");
    await checkConnectivity();
    expect(send.mock.calls[0][0].message).toContain("stream fallback is disconnected too");
  });

  it("names a disabled stream in the alert", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(3 * 60 * 60);
    getStreamStatus.mockReturnValue({ status: "disabled", lastError: null, connectedAt: null });
    const { checkConnectivity } = await import("./connectivity-watchdog");
    await checkConnectivity();
    expect(send.mock.calls[0][0].message).toContain("stream fallback is disabled (no SuperAdmin credential configured)");
  });

  it("exposes streamStatus and lastEventSource on the connectivity status", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(5);
    getStreamStatus.mockReturnValue({ status: "connected", lastError: null, connectedAt: null });
    getLastEventSource.mockReturnValue("stream");
    const { checkConnectivity, getConnectivityStatus } = await import("./connectivity-watchdog");
    await checkConnectivity();
    expect(getConnectivityStatus().streamStatus).toBe("connected");
    expect(getConnectivityStatus().lastEventSource).toBe("stream");
  });

  it("checkConnectivityNow also refreshes the slow device-health poll", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(5);
    const { checkConnectivityNow } = await import("./connectivity-watchdog");
    await checkConnectivityNow();
    expect(checkDeviceHealth).toHaveBeenCalledTimes(1);
  });

  /**
   * instrumentation.ts (the scheduler caller) and a route handler (the
   * status reader) end up in separate Turbopack/webpack bundles, so a
   * plain module-scoped variable gives each its own copy — status written
   * by one is invisible to the other, which is exactly how /api/health
   * kept showing checkedAt: null in production despite the watchdog
   * demonstrably running (see the "default camera unreachable" log).
   * Simulate that split with vi.resetModules() between the write and the
   * read to prove the globalThis-backed status survives it.
   */
  it("survives a fresh module import, simulating instrumentation.ts's separate bundle", async () => {
    settings.clear();
    getLastWebhookAgeSec.mockReturnValue(5);
    const writer = await import("./connectivity-watchdog");
    await writer.checkConnectivity();

    vi.resetModules();
    const reader = await import("./connectivity-watchdog");
    expect(reader.getConnectivityStatus().checkedAt).not.toBeNull();
  });
});
