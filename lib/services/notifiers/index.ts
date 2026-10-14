import { logger } from "@/lib/logger";
import { getSetting, getSettingsRevision } from "../settings";
import { ntfy } from "./ntfy";
import { signal } from "./signal";
import { slack } from "./slack";
import { telegram } from "./telegram";
import { ALERT_KINDS, parseAlertKinds, RoutedNotifier, type AlertKind } from "./routing";
import type { Channel, ChannelDef, Notifier } from "./types";

export type { AlertPayload, Channel, ChannelContext, ChannelDef, ChannelId, Notifier } from "./types";
export { ALERT_KINDS, type AlertKind } from "./routing";
export { NtfyChannel } from "./ntfy";
export { SignalChannel } from "./signal";
export { SlackChannel } from "./slack";
export { TelegramChannel } from "./telegram";

/** Every channel the app knows, in the order alerts fan out and settings render. */
export const CHANNELS: ChannelDef[] = [slack, ntfy, telegram, signal];

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

/** Every enabled channel, each limited to the alert kinds routed to it. */
export function buildNotifier(): Notifier {
  const notifiers = listChannels()
    .filter((c) => c.enabled)
    .map((c) => (c.kinds.size === ALERT_KINDS.length ? c.channel : new RoutedNotifier(c.channel, c.kinds)));
  return notifiers.length === 0 ? new NullNotifier() : notifiers.length === 1 ? notifiers[0] : new CompositeNotifier(notifiers);
}

export interface ListedChannel {
  channel: Channel;
  enabled: boolean;
  kinds: ReadonlySet<AlertKind>;
}

/** The channels with their fields filled in, switched on or not, for fan-out and for Settings > Send test alert. */
export function listChannels(): ListedChannel[] {
  const ctx = {
    consoleCamerasUrl: getSetting("protectConsoleCamerasUrl") ?? undefined,
    timeZone: getSetting("alertTimezone") ?? "UTC",
  };
  return CHANNELS.map((def) => ({
    channel: def.create((key) => getSetting(key), ctx),
    // Unset means on, and every kind: installs from before routing existed keep working untouched.
    enabled: getSetting(`${def.id}Enabled`) !== "false",
    kinds: parseAlertKinds(getSetting(`${def.id}AlertKinds`)),
  })).filter((c) => c.channel.isConfigured());
}
