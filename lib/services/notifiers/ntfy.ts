import { httpUrl, text } from "../setting-schemas";
import type { FieldDef } from "../setting-schemas";
import { formatAlertTime } from "./format";
import { alertKindsSchema, enabledSchema } from "./routing";
import type { AlertPayload, Channel, ChannelContext, ChannelDef } from "./types";
import { postOnce, sendWithRetry, TEST_MESSAGE } from "./util";

export const ntfyFields = {
  ntfyUrl: { group: "notifications", schema: httpUrl, env: "NTFY_URL" },
  ntfyTopic: { group: "notifications", schema: text(255), env: "NTFY_TOPIC" },
  ntfyEnabled: { group: "notifications", schema: enabledSchema },
  ntfyAlertKinds: { group: "notifications", schema: alertKindsSchema },
} satisfies Record<string, FieldDef>;

export interface NtfyConfig {
  url?: string;
  topic?: string;
}

/**
 * Self-hosted ntfy push. Unlike a Slack Incoming Webhook, ntfy's publish
 * endpoint accepts the snapshot bytes directly in the request body, so this
 * is the channel that actually delivers the image inline.
 */
export class NtfyChannel implements Channel {
  readonly id = "ntfy";
  readonly name = "ntfy";

  constructor(
    private readonly config: NtfyConfig,
    private readonly ctx: ChannelContext,
  ) {}

  isConfigured(): boolean {
    return !!this.config.url && !!this.config.topic;
  }

  async send(alert: AlertPayload): Promise<void> {
    const url = `${this.config.url}/${this.config.topic}`;
    const title =
      alert.kind === "HEALTH"
        ? "Alarm system health"
        : alert.kind === "DURESS"
          ? "Duress code used"
          : // Header values must be Latin-1: fetch throws on an em dash, which dropped every ALARM push that named a sensor.
            `Alarm triggered${alert.sensorId ? ` - ${alert.sensorId}` : ""}`;
    const headers: Record<string, string> = {
      Title: title,
      // A health warning is not a break-in: it must not bypass a phone's
      // do-not-disturb the way an ALARM/DURESS push deliberately does.
      Priority: alert.kind === "HEALTH" ? "default" : "urgent",
    };
    // ntfy's Click header takes one URL, so prefer the sensor's specific
    // camera when there is one and fall back to the general console link.
    const click = alert.liveViewUrl || this.ctx.consoleCamerasUrl;
    if (click) headers.Click = click;
    if (alert.snapshot) {
      headers.Filename = "snapshot.jpg";
    }

    await sendWithRetry("ntfy notification failed after retry", async () => {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10_000),
        method: "POST",
        headers,
        body: alert.snapshot
          ? new Uint8Array(alert.snapshot.buffer)
          : alert.kind === "HEALTH"
            ? `${alert.message ?? "Something needs attention"} (${formatAlertTime(alert.at, this.ctx.timeZone)}).`
            : `Alarm — ${alert.kind} at ${formatAlertTime(alert.at, this.ctx.timeZone)}.`,
      });
      if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
    });
  }

  test(): Promise<void> {
    return postOnce(`${this.config.url}/${this.config.topic}`, { method: "POST", headers: { Title: "Test alert" }, body: TEST_MESSAGE });
  }
}

export const ntfy: ChannelDef = {
  id: "ntfy",
  name: "ntfy",
  fields: ntfyFields,
  create: (read, ctx) =>
    new NtfyChannel({ url: read("ntfyUrl")?.replace(/\/+$/, ""), topic: read("ntfyTopic") ?? undefined }, ctx),
};
