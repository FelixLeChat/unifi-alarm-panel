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
 * set = normal certificate verification. The settings are read fresh per
 * call so a change applies at once, but the Agent itself is cached per
 * setting value: the arm-state poll runs every 3s, and a new Agent per call
 * meant a new connection pool and a TLS handshake each time, never closed.
 * Shared by protect-client.ts (the documented Integration API) and
 * protect-alarm-sync.ts (the private Alarm Manager API) — both talk to the
 * same console over HTTPS.
 */
let cached: { key: string; agent: Agent } | null = null;

export function getProtectDispatcher(): Agent | undefined {
  const caCert = getSetting("protectCaCert");
  const insecure = !caCert && isProtectTlsInsecure();
  if (!caCert && !insecure) return undefined;
  const key = caCert ? `ca:${caCert}` : "insecure";
  if (cached?.key !== key) {
    void cached?.agent.close().catch(() => {});
    cached = {
      key,
      agent: caCert ? new Agent({ connect: { ca: caCert } }) : new Agent({ connect: { rejectUnauthorized: false } }),
    };
  }
  return cached.agent;
}

export function isProtectTlsInsecure(): boolean {
  return getSetting("protectInsecureTls") === "true";
}
