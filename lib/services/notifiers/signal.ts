import { logger } from "@/lib/logger";
import { httpUrl, text } from "../setting-schemas";
import type { FieldDef } from "../setting-schemas";
import { alertKindsSchema, enabledSchema } from "./routing";
import { formatMessage } from "./format";
import type { AlertPayload, Channel, ChannelContext, ChannelDef } from "./types";
import { describeNetworkError, sendWithRetry, TEST_MESSAGE } from "./util";

const NUMBER = /^\+\d{6,15}$/;
// A group id as signal-cli-rest-api lists it under /v1/groups: "group." and the base64 id.
const RECIPIENT = /^(\+\d{6,15}|group\.[A-Za-z0-9+/=_-]+)$/;

const parseRecipients = (raw: string) =>
  raw
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);

export const signalFields = {
  signalApiUrl: { group: "notifications", schema: httpUrl, env: "SIGNAL_API_URL" },
  signalNumber: {
    group: "notifications",
    schema: text(32).refine((v) => NUMBER.test(v), "must be an international number like +15145550100"),
    env: "SIGNAL_NUMBER",
  },
  signalRecipients: {
    group: "notifications",
    schema: text(1000).refine(
      (v) => parseRecipients(v).length > 0 && parseRecipients(v).every((r) => RECIPIENT.test(r)),
      "must be comma-separated international numbers (+15145550100) or group ids (group.…)",
    ),
    env: "SIGNAL_RECIPIENTS",
  },
  signalEnabled: { group: "notifications", schema: enabledSchema },
  signalAlertKinds: { group: "notifications", schema: alertKindsSchema },
} satisfies Record<string, FieldDef>;

export interface SignalConfig {
  apiUrl?: string;
  number?: string;
  recipients?: string[];
}

const TIMEOUT_MS = 30_000;

/**
 * A self-hosted bbernhard/signal-cli-rest-api container on the LAN. It has no
 * authentication of its own, so there is nothing secret to store here: keep it
 * reachable only from this app (see docs/SIGNAL.md). One `POST /v2/send`
 * carries the text and, when there is one, the snapshot as a base64 data URI.
 */
export class SignalChannel implements Channel {
  readonly id = "signal";
  readonly name = "Signal";

  constructor(
    private readonly config: SignalConfig,
    private readonly ctx: ChannelContext,
  ) {}

  isConfigured(): boolean {
    return !!this.config.apiUrl && !!this.config.number && !!this.config.recipients?.length;
  }

  /** If the attachment is refused, the text goes out alone, so the alert never depends on the image. */
  async send(alert: AlertPayload): Promise<void> {
    const message = formatMessage(alert, this.ctx.timeZone, this.ctx.consoleCamerasUrl);
    if (alert.snapshot) {
      try {
        await this.post(message, alert.snapshot);
        return;
      } catch (err) {
        logger.error({ err }, "Signal snapshot attachment failed, sending the text alone");
      }
    }
    await sendWithRetry("Signal notification failed after retry", () => this.post(message));
  }

  test(): Promise<void> {
    return this.post(TEST_MESSAGE);
  }

  private async post(message: string, snapshot?: AlertPayload["snapshot"]): Promise<void> {
    const body: Record<string, unknown> = {
      message,
      number: this.config.number,
      recipients: this.config.recipients,
      // The container may default to styled text, where `_` and `*` in a sensor id would turn into formatting.
      text_mode: "normal",
    };
    if (snapshot) {
      const filename = snapshot.contentType.includes("png") ? "snapshot.png" : "snapshot.jpg";
      body.base64_attachments = [
        `data:${snapshot.contentType};filename=${filename};base64,${snapshot.buffer.toString("base64")}`,
      ];
    }
    let res: Response;
    try {
      res = await fetch(`${this.config.apiUrl}/v2/send`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(`Signal API unreachable: ${describeNetworkError(err)}`);
    }
    if (res.ok) return;
    // The container answers { "error": "Specified account does not exist" }.
    const failure = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(`Signal API answered ${res.status}${failure?.error ? `: ${failure.error}` : ""}`);
  }
}

export const signal: ChannelDef = {
  id: "signal",
  name: "Signal",
  fields: signalFields,
  create: (read, ctx) =>
    new SignalChannel(
      {
        apiUrl: read("signalApiUrl")?.replace(/\/+$/, ""),
        number: read("signalNumber") ?? undefined,
        recipients: parseRecipients(read("signalRecipients") ?? ""),
      },
      ctx,
    ),
};
