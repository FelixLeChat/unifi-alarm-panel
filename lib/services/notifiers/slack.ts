import { logger } from "@/lib/logger";
import type { Snapshot } from "../protect-client";
import { secret, text } from "../setting-schemas";
import type { FieldDef } from "../setting-schemas";
import { alertKindsSchema, enabledSchema } from "./routing";
import { formatMessage } from "./format";
import type { AlertPayload, Channel, ChannelContext, ChannelDef } from "./types";
import { postOnce, sendWithRetry, TEST_MESSAGE } from "./util";

export const slackFields = {
  slackWebhookUrl: { group: "notifications", schema: secret, env: "SLACK_WEBHOOK_URL", secret: true },
  slackBotToken: { group: "notifications", schema: secret, env: "SLACK_BOT_TOKEN", secret: true },
  slackChannelId: { group: "notifications", schema: text(64), env: "SLACK_CHANNEL_ID" },
  slackEnabled: { group: "notifications", schema: enabledSchema },
  slackAlertKinds: { group: "notifications", schema: alertKindsSchema },
} satisfies Record<string, FieldDef>;

export interface SlackConfig {
  webhookUrl?: string;
  botToken?: string;
  channelId?: string;
}

/**
 * The text alert always goes out via the Incoming Webhook. The snapshot
 * image is a separate, optional path: a plain Incoming Webhook can't accept
 * a file upload (only an `image_url` Slack's own servers can fetch, which a
 * LAN-only camera snapshot isn't) — that needs a real Slack Bot token and
 * the files API instead, so it's only attempted when botToken + channelId
 * are configured. Its failure never affects the text alert, which has
 * already been sent independently by the time it's attempted.
 */
export class SlackChannel implements Channel {
  readonly id = "slack";
  readonly name = "Slack";

  constructor(
    private readonly config: SlackConfig,
    private readonly ctx: ChannelContext,
  ) {}

  isConfigured(): boolean {
    return !!this.config.webhookUrl;
  }

  async send(alert: AlertPayload): Promise<void> {
    const message = formatMessage(alert, this.ctx.timeZone, this.ctx.consoleCamerasUrl);
    await sendWithRetry("Slack notification failed after retry", async () => {
      const res = await fetch(this.config.webhookUrl!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
      if (!res.ok) throw new Error(`Slack webhook responded ${res.status}`);
    });

    if (alert.snapshot && this.config.botToken && this.config.channelId) {
      await this.uploadSnapshot(alert.snapshot).catch((err) =>
        logger.error({ err }, "Slack snapshot upload failed (text alert already sent)"),
      );
    }
  }

  test(): Promise<void> {
    return postOnce(this.config.webhookUrl!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: TEST_MESSAGE }),
    });
  }

  /** slack.com/apis/files-uploading-using — the current (non-deprecated) 3-step upload flow. */
  private async uploadSnapshot(snapshot: Snapshot): Promise<void> {
    const filename = snapshot.contentType.includes("png") ? "snapshot.png" : "snapshot.jpg";

    const urlRes = await fetch("https://slack.com/api/files.getUploadURLExternal", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.botToken}`,
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
        Authorization: `Bearer ${this.config.botToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        files: [{ id: urlBody.file_id, title: filename }],
        channel_id: this.config.channelId,
      }),
    });
    const completeBody = (await completeRes.json()) as { ok: boolean; error?: string };
    if (!completeBody.ok) {
      throw new Error(`files.completeUploadExternal failed: ${completeBody.error ?? completeRes.status}`);
    }
  }
}

export const slack: ChannelDef = {
  id: "slack",
  name: "Slack",
  fields: slackFields,
  create: (read, ctx) =>
    new SlackChannel(
      {
        webhookUrl: read("slackWebhookUrl") ?? undefined,
        botToken: read("slackBotToken") ?? undefined,
        channelId: read("slackChannelId") ?? undefined,
      },
      ctx,
    ),
};
