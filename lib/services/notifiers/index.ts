import { logger } from "@/lib/logger";
import { getSetting, getSettingsRevision } from "../settings";
import { ntfy } from "./ntfy";
import { slack } from "./slack";
import { telegram } from "./telegram";
import type { Channel, ChannelDef, Notifier } from "./types";

export type { AlertPayload, Channel, ChannelContext, ChannelDef, Notifier } from "./types";
export { NtfyChannel } from "./ntfy";
export { SlackChannel } from "./slack";
export { TelegramChannel } from "./telegram";

/** Every channel the app knows, in the order alerts fan out and settings render. */
export const CHANNELS: ChannelDef[] = [slack, ntfy, telegram];

export class NullNotifier implements Notifier {
  async send(): Promise<void> {}
}

/** Fans one alert out to every configured notifier; one failing never blocks another. */
export class CompositeNotifier implements Notifier {
  constructor(private readonly notifiers: Notifier[]) {}

  async send(alert: Parameters<Notifier["send"]>[0]): Promise<void> {
    const results = await Promise.allSettled(this.notifiers.map((n) => n.send(alert)));
    for (const result of results) {
      if (result.status === "rejected") {
        logger.error({ err: result.reason }, "a notifier in the composite failed");
      }
    }
  }
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
  const channels = buildChannels();
  return channels.length === 0 ? new NullNotifier() : channels.length === 1 ? channels[0] : new CompositeNotifier(channels);
}

/** The configured channels, for fan-out and for Settings > Send test alert. */
export function buildChannels(): Channel[] {
  const ctx = {
    consoleCamerasUrl: getSetting("protectConsoleCamerasUrl") ?? undefined,
    timeZone: getSetting("alertTimezone") ?? "UTC",
  };
  return CHANNELS.map((def) => def.create((key) => getSetting(key), ctx)).filter((channel) => channel.isConfigured());
}
