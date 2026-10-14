import type { AlertPayload } from "./types";

// Alerts carry `at` as an ISO/UTC instant (see lib/engine/index.ts) — rendered
// here, at the display boundary, in the timezone set under Settings >
// Notifications rather than raw UTC.

/** "2026-09-01T18:32:47.828Z" -> "2026-09-01 18:32:47" in timeZone. Falls back to the input unchanged if it isn't a parseable date, so a bad value degrades gracefully instead of blocking the alert. */
export function formatAlertTime(at: string, timeZone: string): string {
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

export function formatMessage(alert: AlertPayload, timeZone: string, consoleCamerasUrl?: string): string {
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
