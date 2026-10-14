import type { Snapshot } from "../protect-client";
import type { FieldDef } from "../setting-schemas";
import type { SettingKey } from "../settings";

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

/** Settings every channel needs to format an alert, read once per build. */
export interface ChannelContext {
  consoleCamerasUrl?: string;
  timeZone: string;
}

export type ChannelId = "slack" | "ntfy" | "telegram" | "signal";

export type SettingReader = (key: SettingKey) => string | null;

/**
 * One configured alert transport. `send` is fire-and-forget from the caller's
 * perspective (see AlarmEngine.runEffect): it owns its retry and never lets a
 * delivery failure escape. `test` makes a single attempt and throws with a
 * readable reason, for Settings > Send test alert.
 */
export interface Channel extends Notifier {
  readonly id: ChannelId;
  readonly name: string;
  isConfigured(): boolean;
  test(): Promise<void>;
}

export interface ChannelDef {
  id: ChannelId;
  name: string;
  /** The settings this channel owns, spread into SETTINGS. Secret ones are flagged. */
  fields: Record<string, FieldDef>;
  create(read: SettingReader, ctx: ChannelContext): Channel;
}
