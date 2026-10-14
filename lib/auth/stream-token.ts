import { randomUUID } from "node:crypto";

/**
 * A plain <img> tag can't carry the X-Admin-Token header, so the live camera
 * proxy route can't use verifyAdminToken directly. Instead, a header-authed
 * request mints a short-lived, single-use, camera-scoped token that goes in
 * the <img src> query string instead of the real admin token — bounding the
 * blast radius of it leaking via browser history/referrers/server logs to
 * "one camera's feed, for a few seconds" rather than full admin access.
 *
 * The issuing route (live-token) and the consuming route (live) are two
 * different route handlers, which end up in separate Turbopack/webpack
 * bundles — same class of bug as lib/services/webhook-intake.ts and
 * connectivity-watchdog.ts, so this lives on globalThis too.
 */
const TTL_MS = 30_000;

interface StreamTokenEntry {
  cameraId: string;
  expiresAt: number;
}

declare global {
  var __uapStreamTokens: Map<string, StreamTokenEntry> | undefined;
}

function getTokens(): Map<string, StreamTokenEntry> {
  if (!globalThis.__uapStreamTokens) globalThis.__uapStreamTokens = new Map();
  return globalThis.__uapStreamTokens;
}

export function issueStreamToken(cameraId: string): string {
  const token = randomUUID();
  getTokens().set(token, { cameraId, expiresAt: Date.now() + TTL_MS });
  return token;
}

/** Single-use: valid tokens are consumed (deleted) on the first check, matching or not. */
export function consumeStreamToken(token: string, cameraId: string): boolean {
  const tokens = getTokens();
  const entry = tokens.get(token);
  tokens.delete(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) return false;
  return entry.cameraId === cameraId;
}
