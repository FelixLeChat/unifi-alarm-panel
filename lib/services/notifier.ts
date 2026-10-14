import { logger } from "@/lib/logger";
import type { Snapshot } from "./protect-client";
import { getSetting, getSettingsRevision } from "./settings";

export interface AlertPayload {
  // HEALTH is the only non-security kind: the system reporting on itself
  // (sensor feed gone quiet, a device offline or on a flat battery). It
  // goes out over the same transports deliberately — a dot in an admin tab
  // nobody has open is what failed to surface a two-day dead webhook feed.
  kind: "ALARM" | "DURESS" | "HEALTH";
  /** HEALTH only: the one-line description of what's wrong. */
  message?: string;
  sensorId?: string;
  at: string;
  snapshot?: Snapshot | null;
  liveViewUrl?: string | null;
}

export interface Notifier {
  send(alert: AlertPayload): Promise<void>;
}

const TEST_MESSAGE = "Test alert from UniFi Alarm Panel. If you can read this, alerts reach this channel.";

/** One configured channel, for Settings > Send test alert. `test()` makes a single attempt and throws with the reason. */
export interface NotifierChannel {
  name: string;
  notifier: Notifier;
  test(): Promise<void>;
}

async function postOnce(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
}

export class NullNotifier implements Notifier {
  async send(): Promise<void> {}
}

/**
 * Fire-and-forget from the caller's perspective (see AlarmEngine.runEffect):
 * every notifier here owns its own retry, and never lets a delivery
 * failure escape to the state machine.
 *
 * The text alert always goes out via the Incoming Webhook. The snapshot
 * image is a separate, optional path: a plain Incoming Webhook can't accept
 * a file upload (only an `image_url` Slack's own servers can fetch, which a
 * LAN-only camera snapshot isn't) — that needs a real Slack Bot token and
 * the files API instead, so it's only attempted when botToken + channelId
 * are configured. Its failure never affects the text alert, which has
 * already been sent independently by the time it's attempted.
 */
export class SlackNotifier implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    private readonly botToken?: string,
    private readonly channelId?: string,
    private readonly consoleCamerasUrl?: string,
    private readonly timeZone = "UTC",
  ) {}

  async send(alert: AlertPayload): Promise<void> {
    const text = formatMessage(alert, this.timeZone, this.consoleCamerasUrl);
    await this.postWithRetry(text);

    if (alert.snapshot && this.botToken && this.channelId) {
      await this.uploadSnapshot(alert.snapshot).catch((err) =>
        logger.error({ err }, "Slack snapshot upload failed (text alert already sent)"),
      );
    }
  }

  private async postWithRetry(text: string, attempt = 0): Promise<void> {
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(`Slack webhook responded ${res.status}`);
    } catch (err) {
      if (attempt < 1) {
        await sleep(1000);
        return this.postWithRetry(text, attempt + 1);
      }
      logger.error({ err }, "Slack notification failed after retry");
    }
  }

  /** slack.com/apis/files-uploading-using — the current (non-deprecated) 3-step upload flow. */
  private async uploadSnapshot(snapshot: Snapshot): Promise<void> {
    const filename = snapshot.contentType.includes("png") ? "snapshot.png" : "snapshot.jpg";

    const urlRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ filename, length: String(snapshot.buffer.length) }),
    });
    const urlBody = (await urlRes.json()) as { ok: boolean; upload_url?: string; file_id?: string; error?: string };
    if (!urlBody.ok || !urlBody.upload_url || !urlBody.file_id) {
      throw new Error(`files.getUploadURLExternal failed: ${urlBody.error ?? urlRes.status}`);
    }

    const uploadRes = await fetch(urlBody.upload_url, {
      method: "POST",
      body: new Uint8Array(snapshot.buffer),
    });
    if (!uploadRes.ok) throw new Error(`upload_url POST failed: ${uploadRes.status}`);

    const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        files: [{ id: urlBody.file_id, title: filename }],
        channel_id: this.channelId,
      }),
    });
    const completeBody = (await completeRes.json()) as { ok: boolean; error?: string };
    if (!completeBody.ok) {
      throw new Error(`files.completeUploadExternal failed: ${completeBody.error ?? completeRes.status}`);
    }
  }
}

// Alerts carry `at` as an ISO/UTC instant (see lib/engine/index.ts) — rendered
// here, at the display boundary, in the timezone set under Settings >
// Notifications rather than raw UTC.

/** "2026-09-01T18:32:47.828Z" -> "2026-09-01 18:32:47" in timeZone. Falls back to the input unchanged if it isn't a parseable date, so a bad value degrades gracefully instead of blocking the alert. */
function formatAlertTime(at: string, timeZone: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function formatMessage(alert: AlertPayload, timeZone: string, consoleCamerasUrl?: string): string {
  const lines: string[] = [];
  const at = formatAlertTime(alert.at, timeZone);
  if (alert.kind === "HEALTH") {
    return `\u{26A0}\u{FE0F} Alarm health: ${alert.message ?? "something needs attention"} (${at}).`;
  }
  if (alert.kind === "DURESS") {
    lines.push(`\u{1F6A8} Duress code used to disarm the alarm at ${at}.`);
  } else {
    const where = alert.sensorId ?? "unknown sensor";
    lines.push(`\u{1F6A8} Alarm triggered — ${where} at ${at}.`);
  }
  if (alert.liveViewUrl) {
    lines.push("View live:", alert.liveViewUrl);
  }
  // Distinct from the per-camera live-view link above: this always points at
  // the console's general camera list, so an alert is never just bare text
  // even before a sensor has its own camera mapped. On its own line so
  // Slack unfurls it as a clean link preview instead of trailing sentence text.
  if (consoleCamerasUrl) {
    lines.push("Check the cameras:", consoleCamerasUrl);
  }
  return lines.join("\n");
}

/**
 * Self-hosted ntfy push. Unlike a Slack Incoming Webhook, ntfy's publish
 * endpoint accepts the snapshot bytes directly in the request body, so this
 * is the notifier that actually delivers the image inline.
 */
export class NtfyNotifier implements Notifier {
  constructor(
    private readonly baseUrl: string,
    private readonly topic: string,
    private readonly consoleCamerasUrl?: string,
    private readonly timeZone = "UTC",
  ) {}

  async send(alert: AlertPayload): Promise<void> {
    await this.postWithRetry(alert);
  }

  private async postWithRetry(alert: AlertPayload, attempt = 0): Promise<void> {
    const url = `${this.baseUrl}/${this.topic}`;
    const title =
      alert.kind === "HEALTH"
        ? "Alarm system health"
        : alert.kind === "DURESS"
          ? "Duress code used"
          : `Alarm triggered${alert.sensorId ? ` — ${alert.sensorId}` : ""}`;
    const headers: Record<string, string> = {
      Title: title,
      // A health warning is not a break-in: it must not bypass a phone's
      // do-not-disturb the way an ALARM/DURESS push deliberately does.
      Priority: alert.kind === "HEALTH" ? "default" : "urgent",
    };
    // ntfy's Click header takes one URL, so prefer the sensor's specific
    // camera when there is one and fall back to the general console link.
    const click = alert.liveViewUrl || this.consoleCamerasUrl;
    if (click) headers.Click = click;
    if (alert.snapshot) {
      headers.Filename = "snapshot.jpg";
    }

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: alert.snapshot
        ? new Uint8Array(alert.snapshot.buffer)
        : alert.kind === "HEALTH"
          ? `${alert.message ?? "Something needs attention"} (${formatAlertTime(alert.at, this.timeZone)}).`
          : `Alarm — ${alert.kind} at ${formatAlertTime(alert.at, this.timeZone)}.`,
      });
      if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
    } catch (err) {
      if (attempt < 1) {
        await sleep(1000);
        return this.postWithRetry(alert, attempt + 1);
      }
      logger.error({ err }, "ntfy notification failed after retry");
    }
  }
}

/** Fans one alert out to every configured notifier; one failing never blocks another. */
export class CompositeNotifier implements Notifier {
  constructor(private readonly notifiers: Notifier[]) {}

  async send(alert: AlertPayload): Promise<void> {
    const results = await Promise.allSettled(this.notifiers.map((n) => n.send(alert)));
    for (const result of results) {
      if (result.status === "rejected") {
        logger.error({ err: result.reason }, "a notifier in the composite failed");
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Rebuilt when the settings revision moves, so a channel saved in the admin
// UI applies to the next alert without a restart (see settings.ts).
let notifierCache: { revision: number; notifier: Notifier } | null = null;

export function getNotifier(): Notifier {
  const revision = getSettingsRevision();
  if (!notifierCache || notifierCache.revision !== revision) {
    notifierCache = { revision, notifier: buildNotifier() };
  }
  return notifierCache.notifier;
}

/** Every channel configured in Settings > Notifications, combined. */
export function buildNotifier(): Notifier {
  const notifiers = buildNotifierChannels().map((c) => c.notifier);
  return notifiers.length === 0 ? new NullNotifier() : notifiers.length === 1 ? notifiers[0] : new CompositeNotifier(notifiers);
}

export function buildNotifierChannels(): NotifierChannel[] {
  const consoleCamerasUrl = getSetting("protectConsoleCamerasUrl") ?? undefined;
  const timeZone = getSetting("alertTimezone") ?? "UTC";
  const channels: NotifierChannel[] = [];
  const slackWebhookUrl = getSetting("slackWebhookUrl");
  if (slackWebhookUrl) {
    channels.push({
      name: "Slack",
      notifier: new SlackNotifier(
        slackWebhookUrl,
        getSetting("slackBotToken") ?? undefined,
        getSetting("slackChannelId") ?? undefined,
        consoleCamerasUrl,
        timeZone,
      ),
      test: () =>
        postOnce(slackWebhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: TEST_MESSAGE }),
        }),
    });
  }
  const ntfyUrl = getSetting("ntfyUrl")?.replace(/\/+$/, "");
  const ntfyTopic = getSetting("ntfyTopic");
  if (ntfyUrl && ntfyTopic) {
    channels.push({
      name: "ntfy",
      notifier: new NtfyNotifier(ntfyUrl, ntfyTopic, consoleCamerasUrl, timeZone),
      test: () => postOnce(`${ntfyUrl}/${ntfyTopic}`, { method: "POST", headers: { Title: "Test alert" }, body: TEST_MESSAGE }),
    });
  }
  return channels;
}
