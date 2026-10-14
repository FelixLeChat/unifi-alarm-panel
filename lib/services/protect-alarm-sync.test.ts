import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reduceArmState } from "./protect-alarm-sync";

const recordAudit = vi.fn();
vi.mock("./audit", () => ({ recordAudit: (...args: unknown[]) => recordAudit(...args) }));

const syncExternalArmState = vi.fn();
vi.mock("@/lib/engine", () => ({ getEngine: () => ({ syncExternalArmState }) }));

vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));
const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("./settings", () => ({ getSetting: (key: string) => settings.get(key) ?? null }));

function loginResponse(): Response {
  return {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) => {
        if (name.toLowerCase() === "set-cookie") return "TOKEN=jwt-value; path=/; secure; httponly";
        if (name.toLowerCase() === "x-csrf-token") return "csrf-value";
        return null;
      },
    },
  } as unknown as Response;
}

function profilesResponse(profiles: unknown[], status = 200): Response {
  return { ok: status < 400, status, json: async () => profiles } as unknown as Response;
}

describe("reduceArmState", () => {
  it("returns null for an empty profile list — nothing to skip a poll on, but also nothing to guess", () => {
    expect(reduceArmState([])).toBeNull();
  });

  it("reports disarmed when every profile is disarmed", () => {
    expect(reduceArmState([{ id: "p1", title: "Office", state: "disarmed" }])).toEqual({
      armed: false,
      breached: false,
    });
  });

  it("reports armed for a settled 'armed' profile", () => {
    expect(reduceArmState([{ id: "p1", title: "Office", state: "armed" }])).toEqual({ armed: true, breached: false });
  });

  it("does NOT report armed while a profile is merely 'arming' — that's UniFi's own exit delay, still counting down", () => {
    expect(reduceArmState([{ id: "p1", title: "Office", state: "arming" }])).toEqual({ armed: false, breached: false });
  });

  it("'arming' is still a recognized state, not treated as unrecognized noise", () => {
    // A second, disarmed profile alone would report armed:false too — the
    // point here is that this doesn't fall into the "unrecognized state"
    // branch (which would log a warning) merely for being "arming".
    expect(reduceArmState([{ id: "p1", title: "Office", state: "arming" }])).not.toBeNull();
  });

  it("armed wins even when one profile is still 'arming' and another is already settled armed", () => {
    const profiles = [
      { id: "p1", title: "Home", state: "arming" },
      { id: "p2", title: "Away", state: "armed" },
    ];
    expect(reduceArmState(profiles)).toEqual({ armed: true, breached: false });
  });

  it("'breached' counts as armed, never as disarmed — the dangerous direction is collapsing it to false", () => {
    expect(reduceArmState([{ id: "p1", title: "Office", state: "breached" }])).toEqual({ armed: true, breached: true });
  });

  it("is an OR across multiple profiles — any one armed means armed", () => {
    const profiles = [
      { id: "p1", title: "Home", state: "disarmed" },
      { id: "p2", title: "Away", state: "armed" },
    ];
    expect(reduceArmState(profiles)).toEqual({ armed: true, breached: false });
  });

  it("returns null when every profile reports an unrecognized state", () => {
    expect(reduceArmState([{ id: "p1", title: "Office", state: "totally-new-value" }])).toBeNull();
  });

  it("skips an unrecognized profile but still uses the others rather than bailing out entirely", () => {
    const profiles = [
      { id: "p1", title: "Office", state: "totally-new-value" },
      { id: "p2", title: "Away", state: "disarmed" },
    ];
    expect(reduceArmState(profiles)).toEqual({ armed: false, breached: false });
  });
});

describe("checkProtectAlarmSync", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    recordAudit.mockReset();
    syncExternalArmState.mockReset();
    delete globalThis.__uapProtectAlarmSyncClient;
    delete globalThis.__uapLastBreachState;
    delete globalThis.__uapLastRemoteArmed;
    settings.clear();
    settings.set("protectHost", "192.168.1.1");
    settings.set("protectAdminUsername", "admin");
    settings.set("protectAdminPassword", "secret");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is a no-op when the console host and SuperAdmin username/password aren't all set", async () => {
    settings.delete("protectHost");
    const { checkProtectAlarmSync } = await import("./protect-alarm-sync");
    await checkProtectAlarmSync();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(syncExternalArmState).not.toHaveBeenCalled();
  });

  it("logs in, sends the session cookie + CSRF header on the profiles fetch, and syncs armed", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(profilesResponse([{ id: "p1", title: "Office", state: "armed" }]));

    const { checkProtectAlarmSync } = await import("./protect-alarm-sync");
    await checkProtectAlarmSync();

    expect(syncExternalArmState).toHaveBeenCalledWith(true);
    const [profilesUrl, profilesInit] = fetchMock.mock.calls[1];
    expect(profilesUrl).toBe("https://192.168.1.1/api/v2/alarms/profiles");
    expect((profilesInit.headers as Record<string, string>).cookie).toBe("TOKEN=jwt-value");
    expect((profilesInit.headers as Record<string, string>)["x-csrf-token"]).toBe("csrf-value");
  });

  it("does not sync as armed while the console is still in its own exit delay ('arming'), only once it settles to 'armed'", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(profilesResponse([{ id: "p1", title: "Office", state: "arming" }]))
      .mockResolvedValueOnce(profilesResponse([{ id: "p1", title: "Office", state: "armed" }]));

    const { checkProtectAlarmSync } = await import("./protect-alarm-sync");
    await checkProtectAlarmSync();
    // First poll establishes the baseline. "arming" reduces to not-armed, and
    // the disarming direction is never mirrored on a first observation (it
    // can't be told apart from "armed from this app's own panel"), so nothing
    // is dispatched yet.
    expect(syncExternalArmState).not.toHaveBeenCalled();

    await checkProtectAlarmSync();
    expect(syncExternalArmState).toHaveBeenLastCalledWith(true);
  });

  it("reuses the session across polls instead of logging in every time", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(profilesResponse([{ id: "p1", title: "Office", state: "disarmed" }]))
      .mockResolvedValueOnce(profilesResponse([{ id: "p1", title: "Office", state: "disarmed" }]));

    const { checkProtectAlarmSync } = await import("./protect-alarm-sync");
    await checkProtectAlarmSync();
    await checkProtectAlarmSync();

    const loginCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes("/api/auth/login"));
    expect(loginCalls).toHaveLength(1);
  });

  it("re-logs in once on a 401, then retries the profiles fetch", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(profilesResponse([], 401))
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(profilesResponse([{ id: "p1", title: "Office", state: "armed" }]));

    const { checkProtectAlarmSync } = await import("./protect-alarm-sync");
    await checkProtectAlarmSync();

    expect(syncExternalArmState).toHaveBeenCalledWith(true);
    const loginCalls = fetchMock.mock.calls.filter(([url]) => (url as string).includes("/api/auth/login"));
    expect(loginCalls).toHaveLength(2);
  });

  it("on a 403, logs the permission error and never calls syncExternalArmState — relogging in can't fix a scope problem", async () => {
    fetchMock.mockResolvedValueOnce(loginResponse()).mockResolvedValueOnce(profilesResponse([], 403));

    const { checkProtectAlarmSync } = await import("./protect-alarm-sync");
    await checkProtectAlarmSync();

    expect(syncExternalArmState).not.toHaveBeenCalled();
    // Only the one login + one profiles call — a 403 must not trigger a relogin retry loop.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("audits protect_breach_detected once on the rising edge, not on every poll while still breached", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(profilesResponse([{ id: "p1", title: "Office", state: "breached" }]))
      .mockResolvedValueOnce(profilesResponse([{ id: "p1", title: "Office", state: "breached" }]));

    const { checkProtectAlarmSync } = await import("./protect-alarm-sync");
    await checkProtectAlarmSync();
    await checkProtectAlarmSync();

    const breachAudits = recordAudit.mock.calls.filter(([, event]) => event === "protect_breach_detected");
    expect(breachAudits).toHaveLength(1);
    // The arm sync is edge-triggered on UniFi's own state too, for the same
    // reason: the first poll observes armed and mirrors it, the second sees no
    // change and stays quiet. (This assertion previously expected a call on
    // BOTH polls, i.e. the level-following behavior the test's own name says
    // it is guarding against.)
    expect(syncExternalArmState).toHaveBeenCalledTimes(1);
    expect(syncExternalArmState).toHaveBeenNthCalledWith(1, true);
  });

  it("skips the poll cycle entirely when nothing in the response is recognized", async () => {
    fetchMock
      .mockResolvedValueOnce(loginResponse())
      .mockResolvedValueOnce(profilesResponse([{ id: "p1", title: "Office", state: "unknown-future-value" }]));

    const { checkProtectAlarmSync } = await import("./protect-alarm-sync");
    await checkProtectAlarmSync();

    expect(syncExternalArmState).not.toHaveBeenCalled();
  });
});
