import { z } from "zod";

// Every PIN in the system is exactly 4 digits (see app/api/admin/pins/route.ts's
// createPinSchema) — this used to allow 4-10, a stale leftover from before that
// was tightened, and had no test either way.
export const pinBodySchema = z.object({
  pin: z.string().regex(/^\d{4}$/, "PIN must be exactly 4 digits"),
});

// Arming (unlike disarming) can be retried with an explicit override once
// the caller has seen which door sensor(s) are open — see AlarmEngine.arm().
export const armBodySchema = pinBodySchema.extend({
  force: z.boolean().optional(),
});
