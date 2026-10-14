import { logger } from "@/lib/logger";
import { secret, text } from "../setting-schemas";
import type { FieldDef } from "../setting-schemas";
import { alertKindsSchema, enabledSchema } from "./routing";
import { formatMessage } from "./format";
import type { AlertPayload, Channel, ChannelContext, ChannelDef } from "./types";
import { describeNetworkError, sendWithRetry, TEST_MESSAGE } from "./util";

export const telegramFields = {
  telegramBotToken: { group: "notifications", schema: secret, env: "TELEGRAM_BOT_TOKEN", secret: true },
  telegramChatId: { group: "notifications", schema: text(64), env: "TELEGRAM_CHAT_ID" },
  telegramEnabled: { group: "notifications", schema: enabledSchema },
  telegramAlertKinds: { group: "notifications", schema: alertKindsSchema },
} satisfies Record<string, FieldDef>;

export interface TelegramConfig {
  botToken?: string;
  chatId?: string;
}

const API = "https://api.telegram.org";
const TIMEOUT_MS = 15_000;

/**
 * Telegram's Bot API puts the token in the URL path, so a URL in an error
 * message (undici repeats it for an invalid URL) would leak it into the logs
 * and the admin UI. Every error this channel throws or logs goes through
 * `describe`, which never includes the URL and scrubs the token anyway.
 */
export class TelegramChannel implements Channel {
  readonly id = "telegram";
  readonly name = "Telegram";

  constructor(
    private readonly config: TelegramConfig,
    private readonly ctx: ChannelContext,
  ) {}

  isConfigured(): boolean {
    return !!this.config.botToken && !!this.config.chatId;
  }

  /**
   * With a snapshot, one `sendPhoto` carries the text as its caption. If that
   * fails, the text goes out alone, so the alert never depends on the image.
   */
  async send(alert: AlertPayload): Promise<void> {
    const message = formatMessage(alert, this.ctx.timeZone, this.ctx.consoleCamerasUrl);
    if (alert.snapshot) {
      try {
        await this.sendPhoto(message, alert.snapshot);
        return;
      } catch (err) {
        logger.error({ err }, "Telegram snapshot upload failed, sending the text alone");
      }
    }
    await sendWithRetry("Telegram notification failed after retry", () => this.sendMessage(message));
  }

  test(): Promise<void> {
    return this.sendMessage(TEST_MESSAGE);
  }

  private sendMessage(message: string): Promise<void> {
    return this.call("sendMessage", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: this.config.chatId, text: message }),
    });
  }

  private sendPhoto(caption: string, snapshot: NonNullable<AlertPayload["snapshot"]>): Promise<void> {
    const form = new FormData();
    form.set("chat_id", this.config.chatId!);
    form.set("caption", caption);
    const filename = snapshot.contentType.includes("png") ? "snapshot.png" : "snapshot.jpg";
    form.set("photo", new Blob([new Uint8Array(snapshot.buffer)], { type: snapshot.contentType }), filename);
    return this.call("sendPhoto", { body: form });
  }

  private async call(method: string, init: RequestInit): Promise<void> {
    let res: Response;
    try {
      res = await fetch(`${API}/bot${this.config.botToken}/${method}`, { method: "POST", ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (err) {
      throw new Error(`Telegram ${method} failed: ${this.describe(err)}`);
    }
    if (res.ok) return;
    // Telegram answers { ok: false, description: "Bad Request: chat not found" }.
    const body = (await res.json().catch(() => null)) as { description?: string } | null;
    throw new Error(`Telegram ${method} answered ${res.status}${body?.description ? `: ${this.describe(body.description)}` : ""}`);
  }

  private describe(err: unknown): string {
    const raw = typeof err === "string" ? err : describeNetworkError(err);
    return raw.split(this.config.botToken!).join("[token]").replace(/\/bot[^/\s]+/g, "/bot[token]");
  }
}

export const telegram: ChannelDef = {
  id: "telegram",
  name: "Telegram",
  fields: telegramFields,
  create: (read, ctx) => new TelegramChannel({ botToken: read("telegramBotToken") ?? undefined, chatId: read("telegramChatId") ?? undefined }, ctx),
};
