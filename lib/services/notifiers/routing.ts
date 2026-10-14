import { bool, text } from "../setting-schemas";
import type { Notifier, AlertPayload } from "./types";

export const ALERT_KINDS = ["ALARM", "DURESS", "HEALTH"] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

const isKind = (v: string): v is AlertKind => (ALERT_KINDS as readonly string[]).includes(v);

/** "ALARM,DURESS" or "none". An empty string can't be stored (an empty value clears a setting), hence "none". */
export const alertKindsSchema = text(64).refine(
  (v) => v === "none" || v.split(",").every(isKind),
  `must be "none" or a comma-separated list of ${ALERT_KINDS.join(", ")}`,
);
export const enabledSchema = bool;

/** Unset means every kind: an install from before routing existed keeps getting everything. */
export function parseAlertKinds(raw: string | null): ReadonlySet<AlertKind> {
  if (raw === null) return new Set(ALERT_KINDS);
  return new Set(raw.split(",").filter(isKind));
}

/** Passes an alert on only if its kind was routed to this channel. */
export class RoutedNotifier implements Notifier {
  constructor(
    private readonly inner: Notifier,
    private readonly kinds: ReadonlySet<AlertKind>,
  ) {}

  async send(alert: AlertPayload): Promise<void> {
    if (this.kinds.has(alert.kind)) await this.inner.send(alert);
  }
}
