import { z } from "zod";

/**
 * Body reader for the unauthenticated routes (/api/arm, /api/disarm,
 * /api/panel/arm). Route handlers put no cap on a request body, and these
 * take a few dozen bytes, so anything larger is refused before parsing.
 */
export const MAX_JSON_BODY_BYTES = 4_096;

export async function readSmallJsonBody(req: Request): Promise<unknown> {
  const length = Number(req.headers.get("content-length"));
  if (length > MAX_JSON_BODY_BYTES) return null;
  const text = await req.text().catch(() => "");
  if (text.length > MAX_JSON_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Every PIN in the system is exactly 4 digits. The admin create and update routes and the kiosk routes all validate against this one schema. */
export const pinSchema = z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits");

export const pinBodySchema = z.object({
  pin: pinSchema,
});

// Arming (unlike disarming) can be retried with an explicit override once
// the caller has seen which door sensor(s) are open — see AlarmEngine.arm().
export const armBodySchema = pinBodySchema.extend({
  force: z.boolean().optional(),
});
