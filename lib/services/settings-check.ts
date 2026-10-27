import { CHANNELS, listChannels, type ChannelId } from "./notifiers";
import { getCredentials, ProtectAlarmPermissionError, ProtectAlarmSyncClient } from "./protect-alarm-sync";
import { describeFetchError, UnifiProtectClient } from "./protect-client";
import { getSetting } from "./settings";

/**
 * Settings > Test connection and Send test alert. Each check runs against
 * the saved settings with fresh clients (never the cached ones), and says
 * why it failed in words an admin can act on.
 */

export interface CheckResult {
  name: string;
  status: "ok" | "failed" | "skipped";
  detail: string;
}

export async function checkConsole(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  const baseUrl = getSetting("protectApiBaseUrl")?.replace(/\/+$/, "");
  const apiKey = getSetting("protectApiKey");
  if (!baseUrl || !apiKey) {
    results.push({ name: "Protect Integration API", status: "skipped", detail: "Set the console URL and API key." });
  } else {
    const probe = await new UnifiProtectClient(baseUrl, apiKey, "").probeCameras();
    results.push(
      probe.ok
        ? {
            name: "Protect Integration API",
            status: "ok",
            detail: `Connected. ${probe.count} camera${probe.count === 1 ? "" : "s"} found.`,
          }
        : { name: "Protect Integration API", status: "failed", detail: probe.error },
    );
  }

  const creds = getCredentials();
  if (!creds) {
    results.push({
      name: "SuperAdmin (arm-state sync, event stream)",
      status: "skipped",
      detail: "Optional. Set the console host, username and password to mirror arming from the UniFi app.",
    });
  } else {
    try {
      const profiles = await new ProtectAlarmSyncClient(creds).getProfiles();
      results.push({
        name: "SuperAdmin (arm-state sync, event stream)",
        status: "ok",
        detail: `Signed in. ${profiles.length} alarm profile${profiles.length === 1 ? "" : "s"} found.`,
      });
    } catch (err) {
      results.push({
        name: "SuperAdmin (arm-state sync, event stream)",
        status: "failed",
        // The alarm endpoints need a SuperAdmin; a Protect-scoped admin signs in fine and then gets 403.
        detail:
          err instanceof ProtectAlarmPermissionError
            ? "Signed in, but the account is not a SuperAdmin (403)."
            : describeFetchError(err),
      });
    }
  }

  const go2rtc = (getSetting("go2rtcApiBaseUrl") ?? "http://127.0.0.1:1984").replace(/\/+$/, "");
  try {
    const res = await fetch(`${go2rtc}/api`, { signal: AbortSignal.timeout(5_000) });
    results.push(
      res.ok
        ? { name: "go2rtc (live camera view)", status: "ok", detail: `Reachable at ${go2rtc}.` }
        : { name: "go2rtc (live camera view)", status: "failed", detail: `${go2rtc} answered ${res.status}.` },
    );
  } catch (err) {
    results.push({
      name: "go2rtc (live camera view)",
      status: "failed",
      detail: `${go2rtc}: ${describeFetchError(err)}. Live view stays off; alerts still work.`,
    });
  }

  return results;
}

/** Sends one test alert per configured channel, or only `channelId`'s. Routing doesn't apply: a test goes out even if the channel is switched off. */
export async function checkNotifications(channelId?: ChannelId): Promise<CheckResult[]> {
  const channels = listChannels().filter((c) => !channelId || c.channel.id === channelId);
  if (channels.length === 0) {
    return [
      channelId
        ? {
            name: CHANNELS.find((d) => d.id === channelId)?.name ?? channelId,
            status: "skipped",
            detail: "Not configured. Fill in its fields and save.",
          }
        : {
            name: "Notifications",
            status: "skipped",
            detail: "No channel configured. Alerts only show on the kiosk and in the audit log.",
          },
    ];
  }
  return Promise.all(
    channels.map(async ({ channel, enabled, kinds }): Promise<CheckResult> => {
      try {
        await channel.test();
        const note = !enabled
          ? " The channel is switched off, so real alerts skip it."
          : kinds.size === 0
            ? " No alert types are routed to it."
            : "";
        return { name: channel.name, status: "ok", detail: `Test alert sent.${note}` };
      } catch (err) {
        return { name: channel.name, status: "failed", detail: describeFetchError(err) };
      }
    }),
  );
}
