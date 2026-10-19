import { readFileSync } from "node:fs";
import { logger } from "@/lib/logger";
import { getAppVersion } from "@/lib/version";

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
}

// Optional token, the same one deploy/update.sh uses to download release
// assets — see deploy/bootstrap.sh. Read fresh each check rather than cached, so
// provisioning the token after boot doesn't need a restart to take effect.
const TOKEN_PATH = "/etc/unifi-alarm-panel-github-token";
const REPO = process.env.UPDATE_CHECK_REPO || "FelixLeChat/unifi-alarm-panel";

const INITIAL_STATUS: UpdateStatus = {
  currentVersion: getAppVersion(),
  latestVersion: null,
  updateAvailable: false,
  checkedAt: null,
  error: null,
};

// See the matching comment in lib/services/connectivity-watchdog.ts:
// instrumentation.ts (which drives the scheduler that calls checkForUpdate)
// is compiled into its own bundle, separate from the route handlers that
// call getUpdateStatus() — a plain module-scoped `let` gives each its own
// copy, so this never actually reached the admin UI. Same globalThis
// workaround as __uapDb / __uapConnectivityStatus.
declare global {
  var __uapUpdateStatus: UpdateStatus | undefined;
}

export function getUpdateStatus(): UpdateStatus {
  return globalThis.__uapUpdateStatus ?? INITIAL_STATUS;
}

function readToken(): { token: string | null; readError: string | null } {
  try {
    return { token: readFileSync(TOKEN_PATH, "utf8").trim(), readError: null };
  } catch (err) {
    // Distinguish "not provisioned yet" (ENOENT) from "provisioned but this
    // process can't read it" (EACCES — e.g. the file's owned root:root while
    // the service runs as `uap`) — the two look identical from the caller's
    // side otherwise, and the latter previously took hours to track down via
    // a live SSH session because the generic message pointed at bootstrap.sh
    // when the actual fix was a chown.
    const code = (err as NodeJS.ErrnoException).code;
    const readError = code === "ENOENT" ? null : `can't read ${TOKEN_PATH}: ${code ?? String(err)} — check its ownership/permissions against the service's User= (see deploy/unifi-alarm-panel.service)`;
    return { token: null, readError };
  }
}

// How many of the most recent releases to fetch before picking the newest by
// published_at — see the comment on checkForUpdate() for why index 0 alone
// isn't safe to trust.
const RELEASES_PAGE_SIZE = 20;

/**
 * Lists releases (not /releases/latest, which excludes pre-releases) and
 * takes the newest by published_at. GitHub's list endpoint does NOT
 * reliably return newest-first despite docs suggesting otherwise —
 * confirmed directly against this repo: with v1.0.0-rc.9/10/11 all
 * published, `releases?per_page=1` returned rc.9 (published 15:57) as
 * element 0, ahead of rc.10 (16:51) and rc.11 (18:00), which silently stuck
 * the admin UI on "latest is v1.0.0-rc.9" long after rc.11 existed. Fetch a
 * page and compare explicitly instead of trusting array order.
 */
export async function checkForUpdate(): Promise<void> {
  const { token, readError } = readToken();
  if (readError) {
    // A token file that exists but can't be read is a deploy mistake, not "no token": say so
    // instead of silently falling back to anonymous requests.
    logger.warn(readError);
    globalThis.__uapUpdateStatus = { ...getUpdateStatus(), checkedAt: new Date().toISOString(), error: readError };
    return;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=${RELEASES_PAGE_SIZE}`, {
      signal: AbortSignal.timeout(10_000),
      // Public releases need no token. One only raises the rate limit, or reaches a private fork.
      headers: { ...(token ? { Authorization: `token ${token}` } : {}), Accept: "application/vnd.github+json" },
    });
    if (!res.ok) throw new Error(`github api ${res.status}`);
    const releases = (await res.json()) as { tag_name: string; published_at: string }[];
    const latest = releases.reduce<(typeof releases)[number] | null>(
      (best, r) => (!best || r.published_at > best.published_at ? r : best),
      null,
    );
    const currentVersion = getAppVersion();
    globalThis.__uapUpdateStatus = {
      currentVersion,
      latestVersion: latest?.tag_name ?? null,
      updateAvailable: latest != null && latest.tag_name !== currentVersion,
      checkedAt: new Date().toISOString(),
      error: null,
    };
  } catch (err) {
    logger.warn({ err }, "update check failed");
    globalThis.__uapUpdateStatus = { ...getUpdateStatus(), checkedAt: new Date().toISOString(), error: String(err) };
  }
}

export const checkUpdateJob = { name: "check-update", intervalMs: 60 * 60 * 1000, run: checkForUpdate };
