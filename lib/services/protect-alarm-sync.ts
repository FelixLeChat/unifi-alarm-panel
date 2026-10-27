import { logger } from "@/lib/logger";
import { getDb } from "@/lib/db";
import { getEngine } from "@/lib/engine";
import { recordAudit } from "./audit";
import { getProtectDispatcher } from "./protect-tls";
import { getSetting } from "./settings";

export interface ProtectAlarmCredentials {
  host: string;
  username: string;
  password: string;
}

interface AlarmProfile {
  id: string;
  title: string;
  state: string;
  active_breach_id?: number;
}

interface Session {
  cookie: string;
  csrfToken: string;
  // Refreshed well before the real ~2h JWT expiry seen on a live console —
  // no need to cut it close, a relogin is cheap and this only runs on a
  // background poll, never a user-facing request path.
  expiresAt: number;
}

const SESSION_LIFETIME_MS = 90 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 5_000;

/**
 * Thrown for a 403 specifically — see README's "UniFi's own arm/disarm
 * state can't be synced" section: this means the account authenticated
 * fine but isn't SuperAdmin, which a relogin can never fix. Surfaced as its
 * own type so the poller can log an actionable message instead of retrying
 * forever on every tick.
 */
export class ProtectAlarmPermissionError extends Error {}

/**
 * A minimal client for UniFi's *private* Alarm Manager v2 API
 * (`/api/v2/alarms/`) — reverse-engineered, not documented by Ubiquiti (see
 * the README section above for how this was confirmed, including the
 * SuperAdmin requirement and the auth mechanism). Cookie-session auth, not
 * PROTECT_API_KEY: `POST /api/auth/login` sets a `TOKEN` JWT cookie and
 * returns an `x-csrf-token` header (the same value as the `csrfToken` claim
 * inside that JWT), which every request must echo back.
 */
export class ProtectAlarmSyncClient {
  private session: Session | null = null;

  constructor(private readonly creds: ProtectAlarmCredentials) {}

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const dispatcher = getProtectDispatcher();
    return fetch(`https://${this.creds.host}${path}`, {
      ...init,
      // Without this, an unreachable console (wrong PROTECT_HOST, a VLAN
      // change, the box off) leaves every request hanging on the OS TCP
      // timeout — a minute-plus. That stalls the admin UI's "Check now",
      // and the 3s arm-state poll just stacks more hung requests behind it.
      // Fail fast instead: this is a LAN call that normally answers in ms.
      signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(dispatcher ? { dispatcher } : {}),
    });
  }

  private async login(): Promise<Session> {
    const res = await this.fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: this.creds.username, password: this.creds.password }),
    });
    if (!res.ok) {
      throw new Error(`Protect Alarm Manager login failed (${res.status})`);
    }
    const setCookie = res.headers.get("set-cookie");
    const csrfToken = res.headers.get("x-csrf-token");
    const tokenMatch = setCookie?.match(/TOKEN=([^;]+)/);
    if (!tokenMatch || !csrfToken) {
      throw new Error("Protect Alarm Manager login response missing the session cookie or CSRF token");
    }
    return { cookie: `TOKEN=${tokenMatch[1]}`, csrfToken, expiresAt: Date.now() + SESSION_LIFETIME_MS };
  }

  /**
   * `GET /api/v2/alarms/profiles` — each configured arm profile (most
   * deployments have exactly one) with its own live `state`. Session
   * handling (relogin, SuperAdmin 403) lives in authedGet below.
   */
  async getProfiles(): Promise<AlarmProfile[]> {
    return this.authedGet<AlarmProfile[]>("/api/v2/alarms/profiles", "profiles");
  }

  /**
   * Any SuperAdmin-only GET on the console, with this class's existing
   * session handling (relogin on a 401, ProtectAlarmPermissionError on a
   * 403 rather than a retry loop). Shared by getProfiles and the device
   * health poll (lib/services/protect-device-health.ts) so there is one
   * session, one login, one place that knows how the auth works.
   */
  async authedGet<T>(path: string, what: string): Promise<T> {
    if (!this.session || Date.now() > this.session.expiresAt) {
      this.session = await this.login();
    }

    const request = () =>
      this.fetch(path, {
        headers: { cookie: this.session!.cookie, "x-csrf-token": this.session!.csrfToken },
      });

    let res = await request();
    if (res.status === 401) {
      this.session = await this.login();
      res = await request();
    }
    if (res.status === 403) {
      throw new ProtectAlarmPermissionError(
        "UniFi Alarm Manager returned 403 — the configured account isn't SuperAdmin (see README)",
      );
    }
    if (!res.ok) {
      throw new Error(`Protect Alarm Manager ${what} fetch failed (${res.status})`);
    }
    return res.json() as Promise<T>;
  }
}

// "breached" counts as armed, never as disarmed — see syncExternalArmState's
// own comment for why: collapsing a breach to "not armed" is the dangerous
// direction for a security tool. "arming" is UniFi's own exit-delay
// countdown — deliberately NOT counted as armed below, so this app waits
// for the console to actually finish arming (not merely start) before
// reacting; see AlarmEngine.syncExternalArmState's comment for what that
// unlocks (a short sync-buffer delay there instead of stacking a second
// full exit delay on top of the one that already ran on UniFi's side).
const SETTLED_ARMED_STATES = new Set(["armed", "breached"]);
const KNOWN_STATES = new Set(["disarmed", "arming", ...SETTLED_ARMED_STATES]);

interface ReducedState {
  armed: boolean;
  breached: boolean;
}

/**
 * Reduces every configured profile to one armed/breached signal. Most
 * consoles (including the one this was built against) have exactly one
 * profile, but a multi-profile setup (e.g. separate "Home"/"Away" delivery
 * profiles) isn't ruled out, so this is an OR across all of them — any
 * profile armed means "the office is armed" — rather than assuming which
 * one is authoritative.
 *
 * Returns null when no profile carries a recognized state (empty list, or
 * every profile reports something outside the observed value domain) —
 * the caller skips that poll cycle entirely rather than guessing a value,
 * same reasoning as an unrecognized state counting toward neither armed nor
 * disarmed.
 */
export function reduceArmState(profiles: AlarmProfile[]): ReducedState | null {
  let sawKnown = false;
  let armed = false;
  let breached = false;

  for (const profile of profiles) {
    if (!KNOWN_STATES.has(profile.state)) {
      logger.warn(
        { profileId: profile.id, state: profile.state },
        "Alarm Manager profile reported an unrecognized state",
      );
      continue;
    }
    sawKnown = true;
    if (SETTLED_ARMED_STATES.has(profile.state)) armed = true;
    if (profile.state === "breached") breached = true;
  }

  return sawKnown ? { armed, breached } : null;
}

export function getCredentials(): ProtectAlarmCredentials | null {
  const host = getSetting("protectHost");
  const username = getSetting("protectAdminUsername");
  const password = getSetting("protectAdminPassword");
  if (!host || !username || !password) return null;
  return { host, username, password };
}

// Lives on globalThis for the same reason as getDb()/getEngine() — see
// their matching comments — even though today only instrumentation.ts's
// scheduler calls this, keeping the reused client instance here rather than
// a plain module-scoped `let` avoids a second, silently-disconnected
// session ever getting created if that changes.
declare global {
  var __uapProtectAlarmSyncClient: { creds: ProtectAlarmCredentials; client: ProtectAlarmSyncClient } | undefined;
  var __uapLastBreachState: boolean | undefined;
  var __uapLastRemoteArmed: boolean | undefined;
}

// A new session when the credentials changed in the admin UI; the same one otherwise.
export function getClient(creds: ProtectAlarmCredentials): ProtectAlarmSyncClient {
  const cached = globalThis.__uapProtectAlarmSyncClient;
  if (
    !cached ||
    cached.creds.host !== creds.host ||
    cached.creds.username !== creds.username ||
    cached.creds.password !== creds.password
  ) {
    globalThis.__uapProtectAlarmSyncClient = { creds, client: new ProtectAlarmSyncClient(creds) };
  }
  return globalThis.__uapProtectAlarmSyncClient!.client;
}

/**
 * Periodic "pull UniFi's real arm state" system task — see
 * AlarmEngine.syncExternalArmState's own comment for what it does with the
 * result. Off by default: the console host and SuperAdmin username/password
 * unset in Settings (the common case — this needs a SuperAdmin
 * credential, a materially bigger trust surface than anything else this
 * app stores, see README) means this is a no-op, same pattern as
 * getProtectClient() falling back to NullProtectClient.
 */
export async function checkProtectAlarmSync(): Promise<void> {
  const creds = getCredentials();
  if (!creds) return;

  let profiles: AlarmProfile[];
  try {
    profiles = await getClient(creds).getProfiles();
  } catch (err) {
    if (err instanceof ProtectAlarmPermissionError) {
      logger.error({ err }, "Protect Alarm Manager sync misconfigured");
    } else {
      logger.warn({ err }, "Protect Alarm Manager poll failed");
    }
    return;
  }

  const reduced = reduceArmState(profiles);
  if (!reduced) return;

  const db = getDb();
  // Audited only on the rising edge (not-breached -> breached), not every
  // poll tick while it stays breached — same "audit the edge, not the
  // level" reasoning as syncExternalArmState only dispatching on a real
  // transition.
  if (reduced.breached && !globalThis.__uapLastBreachState) {
    recordAudit(db, "protect_breach_detected", {
      actorLabel: "UniFi",
      detail: { profiles: profiles.map((p) => ({ id: p.id, title: p.title, state: p.state })) },
    });
  }
  globalThis.__uapLastBreachState = reduced.breached;

  // Act on an edge in UNIFI's own state, never on its level. Handing the raw
  // level to the engine on every tick would make UniFi authoritative over this
  // app: arming from this app's own panel (which deliberately never writes to
  // UniFi) disagrees with a still-"disarmed" console, so the very next 3s poll
  // would undo it — and a PIN disarm at the door would be re-armed 3s later,
  // with the occupant inside. That inverts the core design decision that arm
  // state lives here, not in UniFi (see README's "one design decision").
  const previousArmed = globalThis.__uapLastRemoteArmed;
  globalThis.__uapLastRemoteArmed = reduced.armed;

  if (previousArmed === undefined) {
    // First poll of this process: no previous remote observation to take an
    // edge against. Mirror only the arming direction — if the console was
    // armed while this app was down, reflecting that is strictly safer than
    // leaving the office unprotected. The disarming direction is deliberately
    // NOT mirrored here, because "UniFi says disarmed" is indistinguishable
    // from "this app was armed from its own panel and UniFi never knew".
    if (reduced.armed) getEngine().syncExternalArmState(true);
    return;
  }

  if (previousArmed !== reduced.armed) {
    getEngine().syncExternalArmState(reduced.armed);
  }
}

export const protectAlarmSyncJob = { name: "protect-alarm-sync", intervalMs: 3_000, run: checkProtectAlarmSync };
