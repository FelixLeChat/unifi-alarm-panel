import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompositeNotifier, NtfyChannel, NullNotifier, SlackChannel, type Notifier } from ".";

const slack = (webhookUrl: string, botToken?: string, channelId?: string, consoleCamerasUrl?: string, timeZone = "UTC") =>
  new SlackChannel({ webhookUrl, botToken, channelId }, { consoleCamerasUrl, timeZone });
const ntfy = (url: string, topic: string, consoleCamerasUrl?: string, timeZone = "UTC") =>
  new NtfyChannel({ url, topic }, { consoleCamerasUrl, timeZone });

describe("NullNotifier", () => {
  it("does nothing and never throws", async () => {
    const notifier: Notifier = new NullNotifier();
    await expect(notifier.send({ kind: "ALARM", at: "now" })).resolves.toBeUndefined();
  });
});

describe("SlackChannel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("posts a message to the webhook URL", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = slack("https://hooks.slack.example/webhook");

    await notifier.send({ kind: "ALARM", sensorId: "front-door", at: "2026-01-01T00:00:00Z" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://hooks.slack.example/webhook");
    expect(JSON.parse(init.body).text).toContain("front-door");
  });

  it("renders the alert time in UTC by default", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = slack("https://hooks.slack.example/webhook");

    await notifier.send({ kind: "ALARM", sensorId: "front-door", at: "2026-09-01T18:32:47.828Z" });

    const text = JSON.parse(fetchMock.mock.calls[0][1].body).text;
    expect(text).toContain("at 2026-09-01 18:32:47.");
  });

  it("renders the alert time in the configured timezone, not raw UTC", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = slack("https://hooks.slack.example/webhook", undefined, undefined, undefined, "America/Toronto");

    // 18:32:47 UTC in September is EDT (UTC-4) -> 14:32:47 local.
    await notifier.send({ kind: "ALARM", sensorId: "front-door", at: "2026-09-01T18:32:47.828Z" });

    const text = JSON.parse(fetchMock.mock.calls[0][1].body).text;
    expect(text).toContain("at 2026-09-01 14:32:47.");
  });

  it("falls back to the raw value when `at` isn't a parseable date, instead of throwing", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = slack("https://hooks.slack.example/webhook");

    await expect(notifier.send({ kind: "ALARM", sensorId: "front-door", at: "not-a-date" })).resolves.toBeUndefined();
    const text = JSON.parse(fetchMock.mock.calls[0][1].body).text;
    expect(text).toContain("at not-a-date.");
  });

  it("retries once on failure, then gives up without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down")).mockResolvedValueOnce({ ok: true });
    const notifier = slack("https://hooks.slack.example/webhook");

    const promise = notifier.send({ kind: "ALARM", at: "now" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("swallows a second consecutive failure instead of throwing", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));
    const notifier = slack("https://hooks.slack.example/webhook");

    const promise = notifier.send({ kind: "ALARM", at: "now" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not attempt a file upload without a bot token + channel configured", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = slack("https://hooks.slack.example/webhook");

    await notifier.send({ kind: "ALARM", at: "now", snapshot: { buffer: Buffer.from([1]), contentType: "image/jpeg" } });

    expect(fetchMock).toHaveBeenCalledTimes(1); // webhook only
  });

  it("does not attempt a file upload when there's no snapshot", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = slack("https://hooks.slack.example/webhook", "xoxb-token", "C123");

    await notifier.send({ kind: "ALARM", at: "now" });

    expect(fetchMock).toHaveBeenCalledTimes(1); // webhook only
  });

  it("uploads the snapshot via the 3-step files API when bot token + channel + snapshot are present", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "https://hooks.slack.example/webhook") {
        return Promise.resolve({ ok: true });
      }
      if (url === "https://slack.com/api/files.getUploadURLExternal") {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, upload_url: "https://files.slack.com/upload/abc", file_id: "F123" }),
        });
      }
      if (url === "https://files.slack.com/upload/abc") {
        return Promise.resolve({ ok: true });
      }
      if (url === "https://slack.com/api/files.completeUploadExternal") {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true }) });
      }
      throw new Error(`unexpected fetch to ${url}`);
    });
    const notifier = slack("https://hooks.slack.example/webhook", "xoxb-token", "C123");

    await notifier.send({
      kind: "ALARM",
      sensorId: "front-door",
      at: "now",
      snapshot: { buffer: Buffer.from([1, 2, 3]), contentType: "image/jpeg" },
    });

    expect(fetchMock).toHaveBeenCalledTimes(4);
    const completeCall = fetchMock.mock.calls.find((c) => c[0] === "https://slack.com/api/files.completeUploadExternal");
    const completeBody = JSON.parse(completeCall![1].body);
    expect(completeBody.channel_id).toBe("C123");
    expect(completeBody.files[0].id).toBe("F123");
  });

  it("appends the general console-cameras link when configured, alongside any specific live-view link", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = slack(
      "https://hooks.slack.example/webhook",
      undefined,
      undefined,
      "https://unifi.ui.com/consoles/abc/protect/dashboard",
    );

    await notifier.send({
      kind: "ALARM",
      sensorId: "unmapped-sensor",
      at: "now",
      liveViewUrl: "https://udm.local/protect/dashboard/cam-1",
    });

    const text = JSON.parse(fetchMock.mock.calls[0][1].body).text;
    expect(text).toContain("View live:\nhttps://udm.local/protect/dashboard/cam-1");
    expect(text).toContain("Check the cameras:\nhttps://unifi.ui.com/consoles/abc/protect/dashboard");
  });

  it("appends the console-cameras link to a DURESS alert too", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = slack(
      "https://hooks.slack.example/webhook",
      undefined,
      undefined,
      "https://unifi.ui.com/consoles/abc/protect/dashboard",
    );

    await notifier.send({ kind: "DURESS", at: "now" });

    const text = JSON.parse(fetchMock.mock.calls[0][1].body).text;
    expect(text).toContain("Check the cameras:\nhttps://unifi.ui.com/consoles/abc/protect/dashboard");
  });

  it("an upload failure doesn't throw or affect the already-sent text alert", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === "https://hooks.slack.example/webhook") return Promise.resolve({ ok: true });
      return Promise.resolve({ ok: true, json: async () => ({ ok: false, error: "invalid_auth" }) });
    });
    const notifier = slack("https://hooks.slack.example/webhook", "bad-token", "C123");

    await expect(
      notifier.send({
        kind: "ALARM",
        at: "now",
        snapshot: { buffer: Buffer.from([1]), contentType: "image/jpeg" },
      }),
    ).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledWith("https://hooks.slack.example/webhook", expect.anything());
  });
});

describe("NtfyChannel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("posts the snapshot bytes as the body when a snapshot is present", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = ntfy("https://ntfy.internal", "alarms");
    const buffer = Buffer.from([1, 2, 3]);

    await notifier.send({
      kind: "ALARM",
      sensorId: "front-door",
      at: "now",
      snapshot: { buffer, contentType: "image/jpeg" },
      liveViewUrl: "https://udm.local/protect/dashboard/cam-1",
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ntfy.internal/alarms");
    expect(init.headers.Click).toBe("https://udm.local/protect/dashboard/cam-1");
    expect(init.headers.Filename).toBe("snapshot.jpg");
    expect(Array.from(init.body)).toEqual([1, 2, 3]);
  });

  it("posts a plain text body when there's no snapshot", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = ntfy("https://ntfy.internal", "alarms");

    await notifier.send({ kind: "DURESS", at: "now" });

    const [, init] = fetchMock.mock.calls[0];
    expect(typeof init.body).toBe("string");
    expect(init.headers.Filename).toBeUndefined();
  });

  it("falls back to the console-cameras link for Click when there's no sensor-specific one", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = ntfy(
      "https://ntfy.internal",
      "alarms",
      "https://unifi.ui.com/consoles/abc/protect/dashboard",
    );

    await notifier.send({ kind: "ALARM", sensorId: "unmapped-sensor", at: "now" });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Click).toBe("https://unifi.ui.com/consoles/abc/protect/dashboard");
  });

  it("prefers the sensor-specific live-view link over the console-cameras fallback for Click", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const notifier = ntfy(
      "https://ntfy.internal",
      "alarms",
      "https://unifi.ui.com/consoles/abc/protect/dashboard",
    );

    await notifier.send({
      kind: "ALARM",
      sensorId: "back-door",
      at: "now",
      liveViewUrl: "https://udm.local/protect/dashboard/cam-1",
    });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Click).toBe("https://udm.local/protect/dashboard/cam-1");
  });

  it("retries once then gives up without throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("down")).mockResolvedValueOnce({ ok: true });
    const notifier = ntfy("https://ntfy.internal", "alarms");

    const promise = notifier.send({ kind: "ALARM", at: "now" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("CompositeNotifier", () => {
  it("fans an alert out to every notifier", async () => {
    const a: Notifier = { send: vi.fn(async () => {}) };
    const b: Notifier = { send: vi.fn(async () => {}) };
    const composite = new CompositeNotifier([a, b]);

    await composite.send({ kind: "ALARM", at: "now" });

    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.send).toHaveBeenCalledTimes(1);
  });

  it("one notifier failing doesn't stop the others or throw", async () => {
    const failing: Notifier = { send: vi.fn(async () => { throw new Error("boom"); }) };
    const ok: Notifier = { send: vi.fn(async () => {}) };
    const composite = new CompositeNotifier([failing, ok]);

    await expect(composite.send({ kind: "ALARM", at: "now" })).resolves.toBeUndefined();
    expect(ok.send).toHaveBeenCalledTimes(1);
  });
});

describe("channel configuration and test()", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("is configured only with what it needs", () => {
    expect(new SlackChannel({}, { timeZone: "UTC" }).isConfigured()).toBe(false);
    expect(slack("https://hooks.slack.example/x").isConfigured()).toBe(true);
    expect(new NtfyChannel({ url: "https://ntfy.internal" }, { timeZone: "UTC" }).isConfigured()).toBe(false);
    expect(ntfy("https://ntfy.internal", "alarms").isConfigured()).toBe(true);
  });

  it("test() makes one attempt and throws with the reason", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);

    await expect(slack("https://hooks.slack.example/x").test()).rejects.toThrow("answered 404");
    await expect(ntfy("https://ntfy.internal", "alarms").test()).rejects.toThrow("answered 404");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
