import { Agent } from "undici";
import { getSetting } from "./settings";

/**
 * The console serves a self-signed cert. NODE_TLS_REJECT_UNAUTHORIZED=0
 * would disable certificate verification for every outbound request the
 * whole process makes (Slack, ntfy, the GitHub update check, ...), not just
 * calls to this one LAN console — so the override lives on a dispatcher
 * passed only to Protect-bound fetch calls instead. Prefer the CA certificate
 * setting (trust the console's actual cert / an internal CA); insecure TLS
 * is a last-resort escape hatch for when that PEM isn't available. Neither
 * set = normal certificate verification. Read fresh per call rather than
 * cached — every caller of this is infrequent, so there's no hot path to
 * optimize here. Shared by protect-client.ts (the documented Integration
 * API) and protect-alarm-sync.ts (the private Alarm Manager API) — both
 * talk to the same console over HTTPS.
 */
export function getProtectDispatcher(): Agent | undefined {
  const caCert = getSetting("protectCaCert");
  if (caCert) {
    return new Agent({ connect: { ca: caCert } });
  }
  if (isProtectTlsInsecure()) {
    return new Agent({ connect: { rejectUnauthorized: false } });
  }
  return undefined;
}

export function isProtectTlsInsecure(): boolean {
  return getSetting("protectInsecureTls") === "true";
}
