import { isUsableSecret, safeEqual } from "./safe-equal";
import { clientKey } from "./client-key";
import { isLockedOut, recordFailure, recordSuccess } from "@/lib/services/rate-limit";
import { logger } from "@/lib/logger";

export function verifyAdminToken(req: Request): boolean {
  const expected = process.env.ADMIN_TOKEN;
  if (!isUsableSecret(expected)) {
    logger.warn(
      "admin request rejected: ADMIN_TOKEN is not configured on this server, or is the placeholder or shorter than 12 characters",
    );
    return false;
  }

  // Namespaced so admin-token brute force can't lock out (or be masked by)
  // the kiosk PIN attempt bucket for the same source.
  const source = clientKey(req);
  const key = `admin:${source}`;
  if (isLockedOut(key)) {
    logger.warn({ source }, "admin request rejected: source is locked out after repeated bad tokens");
    return false;
  }

  const provided = req.headers.get("x-admin-token") ?? "";
  const ok = safeEqual(provided, expected);
  if (ok) {
    recordSuccess(key);
  } else {
    recordFailure(key);
    logger.warn({ source }, "admin request rejected: token didn't match");
  }
  return ok;
}
