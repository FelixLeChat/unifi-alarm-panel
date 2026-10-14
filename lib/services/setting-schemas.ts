import { z } from "zod";

/** Building blocks shared by `SETTINGS` and the notification channels that declare their own fields. */

export const SETTINGS_GROUPS = ["console", "notifications", "panel"] as const;
export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

export interface FieldDef {
  group: SettingsGroup;
  schema: z.ZodType<string>;
  /** Read once by seedSettingsFromEnv. */
  env?: string;
  secret?: boolean;
}

export const text = (max = 500) => z.string().trim().min(1).max(max);
export const httpUrl = text(2000).refine((v) => /^https?:\/\/[^\s]+$/i.test(v), "must be an http:// or https:// URL");
export const bool = z.enum(["true", "false"]);
export const secret = text(4000);
