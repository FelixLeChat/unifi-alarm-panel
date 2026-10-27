import { isUsableSecret, safeEqual } from "./safe-equal";
import { clientKey } from "./client-key";
import { isLockedOut, recordFailure, recordSuccess } from "@/lib/services/rate-limit";
import { logger } from "@/lib/logger";

/**
 * UniFi Alarm Manager sends the shared secret as a header or a query param
 * (both are supported by the outbound-webhook feature).
 *
 * Every rejection path logs (source IP only — never the secret, which pino's
 * redact config also backstops) so "no sensors are showing up" is
 * diagnosable from server logs instead of a silent 401 with zero trace.
 */
export function verifyWebhookSecret(req: Request, url: URL): boolean {
  const expected = process.env.WEBHOOK_SHARED_SECRET;
  if (!isUsableSecret(expected)) {
    logger.warn(
      "sensor webhook rejected: WEBHOOK_SHARED_SECRET is not configured on this server, or is the placeholder or shorter than 12 characters",
    );
    return false;
  }

  const source = clientKey(req);
  const key = `webhook:${source}`;
  if (isLockedOut(key)) {
    logger.warn({ source }, "sensor webhook rejected: source is locked out after repeated bad secrets");
    return false;
  }

  const provided = req.headers.get("x-alarm-secret") ?? url.searchParams.get("token") ?? "";
  const ok = safeEqual(provided, expected);
  if (ok) {
    recordSuccess(key);
  } else {
    recordFailure(key);
    logger.warn({ source }, "sensor webhook rejected: shared secret didn't match");
  }
  return ok;
}
