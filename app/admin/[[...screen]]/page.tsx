"use client";

import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { AppShell } from "../AppShell";
import {
  fetchAdminSnapshot,
  fetchAuditWindow,
  fetchConnectivityStatus,
  fetchSettings,
  fetchStatus,
  fetchUpdateStatus,
  triggerUpdate,
  type AdminSnapshot,
  type ConnectivityStatus,
  type SettingsSnapshot,
  type UpdateStatus,
} from "../api";
import { AuditLogScreen } from "../AuditLogScreen";
import { DelaysScreen } from "../DelaysScreen";
import { EventsScreen } from "../EventsScreen";
import { LoginScreen } from "../LoginScreen";
import { OverviewScreen } from "../OverviewScreen";
import { PinsScreen } from "../PinsScreen";
import { SensorsScreen } from "../SensorsScreen";
import { SettingsScreen } from "../SettingsScreen";
import { SetupWizard } from "../SetupWizard";
import { TasksScreen } from "../TasksScreen";
import type { AuditRow, Screen, StatusResponse } from "../shared";

const TOKEN_KEY = "uap-admin-token";
// Per browser session, so "Exit setup" sticks until the tab closes but a fresh login with no console still offers it.
const SETUP_DISMISSED_KEY = "uap-setup-dismissed";
const HEATMAP_WINDOW_DAYS = 182; // 26 weeks, per the Overview heatmap spec

const EMPTY_SNAPSHOT: AdminSnapshot = {
  pins: [],
  audit: [],
  sensors: [],
  config: {},
  lastArmDisarm: null,
  sensorFeed: { ageSec: 0, stale: false, everReceived: false },
};

const SCREENS: Screen[] = ["overview", "sensors", "pins", "delays", "audit", "events", "tasks", "settings"];

/** /admin/[[...screen]] — an unrecognized or extra path segment falls back to Overview rather than 404ing. */
function screenFromParam(segments: string[] | undefined): Screen {
  const candidate = segments?.[0];
  return (SCREENS as string[]).includes(candidate ?? "") ? (candidate as Screen) : "overview";
}

export default function AdminPage() {
  const router = useRouter();
  const params = useParams<{ screen?: string[] }>();
  const screen = screenFromParam(params.screen);
  const setScreen = useCallback(
    (next: Screen) => {
      router.push(next === "overview" ? "/admin" : `/admin/${next}`);
    },
    [router],
  );

  const [token, setToken] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");
  const [tokenError, setTokenError] = useState<string | null>(null);

  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [snapshot, setSnapshot] = useState<AdminSnapshot>(EMPTY_SNAPSHOT);
  const [auditWindow, setAuditWindow] = useState<AuditRow[] | null>(null);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [connectivity, setConnectivity] = useState<ConnectivityStatus | null>(null);
  const [settings, setSettings] = useState<SettingsSnapshot | null>(null);
  // Decided once, when settings first load: saving the console step must not close the wizard mid-flow.
  const [showSetup, setShowSetup] = useState(false);
  // Gates the update-status poll below on a *confirmed* login rather than on
  // `token` alone — every admin-gated fetch a page load fires (pins, audit,
  // config, the heatmap window) shares one rate-limit bucket keyed by
  // source (see lib/services/rate-limit.ts), and a single wrong-token
  // attempt already burns most of that budget. Firing yet another
  // admin-gated request before we know the token is even valid risks
  // tripping the lockout on a bad attempt instead of just rejecting it.
  const [loggedIn, setLoggedIn] = useState(false);

  useEffect(() => {
    // Client-only read, deliberately deferred to an effect: reading
    // sessionStorage during the initial render would mismatch the
    // server-rendered "signed out" HTML.
    const stored = sessionStorage.getItem(TOKEN_KEY);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (stored) setToken(stored);
  }, []);

  const reload = useCallback(async () => {
    if (!token) return;
    const result = await fetchAdminSnapshot(token).catch(() => "error" as const);
    if (result === "unauthorized") {
      sessionStorage.removeItem(TOKEN_KEY);
      setToken(null);
      setLoggedIn(false);
      setTokenError("Token rejected.");
      return;
    }
    if (result === "error") {
      // Keep what is on screen on a poll failure; before the first load, fall back to the login screen with a message rather than a blank page.
      setLoggedIn((was) => {
        if (!was) setTokenError("Could not reach the server. Try again.");
        return was;
      });
      return;
    }
    setSnapshot(result);
    setLoggedIn(true);
  }, [token]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the initial load is the effect
    void reload();
  }, [reload]);

  // Settings drive the first-run wizard, so they load as soon as the token is confirmed.
  useEffect(() => {
    if (!token || !loggedIn) return;
    let cancelled = false;
    fetchSettings(token)
      .then((s) => {
        if (cancelled || !s) return;
        setSettings(s);
        setShowSetup(!s.consoleConfigured && sessionStorage.getItem(SETUP_DISMISSED_KEY) !== "true");
      })
      .catch(() => {
        // Settings only gate the setup wizard; a failed load leaves it closed and the next login retries.
      });
    return () => {
      cancelled = true;
    };
  }, [token, loggedIn]);

  // The Sensors screen is the one place where the data going stale is the
  // whole point of looking at it — "tripped <date>" and the status dot both
  // answer "is anything coming in right now". Without this the list was a
  // snapshot from whenever the tab was opened, so a trip that happened while
  // someone watched the screen looked exactly like a sensor that had gone
  // quiet. Only this screen polls: the others hold forms whose in-progress
  // edits a background refresh has no business touching.
  useEffect(() => {
    if (!token || !loggedIn || screen !== "sensors") return;
    const id = setInterval(() => void reload(), 15_000);
    return () => clearInterval(id);
  }, [token, loggedIn, screen, reload]);

  // The persistent header pill needs the live state machine, independent of
  // the admin-token-gated data above (this endpoint has no auth, same as the
  // kiosk panel) — poll it every ~2s per the handoff spec.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    async function poll() {
      try {
        const s = await fetchStatus();
        if (!cancelled) setStatus(s);
      } catch {
        // Transient network hiccup — the next tick retries.
      }
    }
    void poll();
    const id = setInterval(() => void poll(), 2000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token]);

  // Update-available banner — 60s is plenty since check-update itself only
  // re-checks GitHub hourly (see lib/services/update-check.ts); frequent
  // enough to show "updating…" progress promptly once triggered. Gated on
  // loggedIn (not just token) — see its declaration above.
  useEffect(() => {
    if (!token || !loggedIn) return;
    let cancelled = false;
    async function poll() {
      try {
        const s = await fetchUpdateStatus(token!);
        if (!cancelled && s) setUpdateStatus(s);
      } catch {
        // Transient network hiccup — the next tick retries.
      }
    }
    void poll();
    const id = setInterval(() => void poll(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [token, loggedIn]);

  // Once the root updater picks the request up and applies it, the running
  // process restarts — this tab is still on the old bundle until it reloads.
  // Watches for a live requested:/applying: -> done:<tag> transition (never
  // fires on the initial load of an already-"done" status from a past
  // update) and reloads shortly after, so "click update" ends with the
  // admin looking at the new version instead of a stale one they have to
  // notice and refresh themselves.
  const prevApplyStatusRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevApplyStatusRef.current;
    const current = updateStatus?.applyStatus ?? null;
    const wasInProgress = prev != null && (prev.startsWith("requested:") || prev.startsWith("applying:"));
    prevApplyStatusRef.current = current;
    if (wasInProgress && current?.startsWith("done:")) {
      toast.success(`Update applied. Reloading to ${current.slice("done:".length)}…`);
      setTimeout(() => window.location.reload(), 1500);
    }
  }, [updateStatus?.applyStatus]);

  const handleTriggerUpdate = useCallback(async () => {
    if (!token || !updateStatus?.latestVersion) return;
    const tag = updateStatus.latestVersion;
    const result = await triggerUpdate(token, tag);
    if (result.ok) {
      toast.success(`Update to ${tag} requested. The box picks it up within a minute.`);
    } else {
      // A 409 here means one was already in flight (see app/api/admin/update/route.ts)
      // — this is what used to silently double-fire on a fast double-click.
      toast.error(result.error ?? "Failed to request the update.");
    }
    const s = await fetchUpdateStatus(token);
    if (s) setUpdateStatus(s);
  }, [token, updateStatus]);

  // Forces an immediate GitHub check from the Tasks screen instead of
  // waiting for the hourly job — see lib/services/update-check.ts. Returns
  // whether the request itself succeeded, so the button can surface a
  // network/auth failure instead of silently doing nothing (fetchUpdateStatus
  // returns null on any non-2xx, which used to be swallowed here).
  const handleCheckUpdateNow = useCallback(async () => {
    if (!token) return false;
    const s = await fetchUpdateStatus(token, { refresh: true });
    if (s) {
      setUpdateStatus(s);
      if (s.error) {
        toast.error(s.error);
      } else {
        toast.success(s.updateAvailable ? `Update available: ${s.latestVersion}` : "Already on the latest version.");
      }
    } else {
      toast.error("Check now failed. The request didn't go through.");
    }
    return s !== null;
  }, [token]);

  // Connectivity watchdog status is only needed on the Tasks screen —
  // fetched lazily the first time it's opened, same pattern as auditWindow.
  useEffect(() => {
    if (!token || screen !== "tasks" || connectivity !== null) return;
    let cancelled = false;
    fetchConnectivityStatus(token)
      .then((s) => {
        if (!cancelled) setConnectivity(s);
      })
      .catch(() => {
        // Stays null, which the Tasks screen shows as "not checked yet"; reopening the screen retries.
      });
    return () => {
      cancelled = true;
    };
  }, [token, screen, connectivity]);

  // Forces an immediate connectivity check from the Tasks screen instead of
  // waiting for the 5-minute job — see lib/services/connectivity-watchdog.ts.
  // Returns whether the request itself succeeded — see handleCheckUpdateNow.
  const handleCheckConnectivityNow = useCallback(async () => {
    if (!token) return false;
    const s = await fetchConnectivityStatus(token, { refresh: true });
    if (s) {
      setConnectivity(s);
      toast.success(s.sensorHeartbeatStale || s.cameraReachable === false ? "Check complete. Something needs attention." : "Check complete. All good.");
    } else {
      toast.error("Check now failed. The request didn't go through.");
    }
    return s !== null;
  }, [token]);

  // Heatmap needs more history than the 50-row admin snapshot carries —
  // fetched once, lazily, the first time Overview is opened.
  useEffect(() => {
    if (!token || screen !== "overview" || auditWindow !== null) return;
    let cancelled = false;
    fetchAuditWindow(token, HEATMAP_WINDOW_DAYS)
      .then((rows) => {
        if (!cancelled) setAuditWindow(rows);
      })
      .catch(() => {
        if (!cancelled) setAuditWindow([]);
      });
    return () => {
      cancelled = true;
    };
  }, [token, screen, auditWindow]);

  const handleArmDisarmSuccess = useCallback(async () => {
    await reload();
    try {
      setStatus(await fetchStatus());
    } catch {
      // Next poll tick will catch up.
    }
  }, [reload]);

  function handleTokenSubmit(e: FormEvent) {
    e.preventDefault();
    sessionStorage.setItem(TOKEN_KEY, tokenInput);
    setToken(tokenInput);
    setTokenInput("");
    setTokenError(null);
  }

  function handleLogout() {
    sessionStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setLoggedIn(false);
  }

  if (!token) {
    return <LoginScreen tokenInput={tokenInput} onTokenInputChange={setTokenInput} onSubmit={handleTokenSubmit} error={tokenError} />;
  }

  // A stored token isn't trusted until reload() confirms it, so a rejected one
  // never flashes the admin UI.
  if (!loggedIn) return null;

  if (settings && showSetup) {
    return (
      <SetupWizard
        settings={settings}
        token={token}
        onSettingsSaved={setSettings}
        onDone={() => {
          sessionStorage.setItem(SETUP_DISMISSED_KEY, "true");
          setShowSetup(false);
          setScreen("overview");
        }}
      />
    );
  }

  return (
    <AppShell
      screen={screen}
      onScreenChange={setScreen}
      onLogout={handleLogout}
      status={status}
      audit={snapshot.audit}
      sensors={snapshot.sensors}
      onArmDisarmSuccess={handleArmDisarmSuccess}
      updateStatus={updateStatus}
      onTriggerUpdate={handleTriggerUpdate}
      token={token}
    >
      {screen === "overview" && (
        <OverviewScreen
          lastArmDisarm={snapshot.lastArmDisarm}
          auditWindow={auditWindow}
          status={status}
          sensors={snapshot.sensors}
          config={snapshot.config}
          onNavigate={setScreen}
        />
      )}
      {screen === "sensors" && (
        <SensorsScreen sensors={snapshot.sensors} sensorFeed={snapshot.sensorFeed} token={token} onSaved={reload} />
      )}
      {screen === "pins" && <PinsScreen pins={snapshot.pins} token={token} onSaved={reload} />}
      {screen === "delays" && <DelaysScreen config={snapshot.config} token={token} onSaved={reload} />}
      {screen === "settings" && (
        <SettingsScreen config={snapshot.config} token={token} onSaved={reload} settings={settings} onSettingsSaved={setSettings} />
      )}
      {screen === "audit" && <AuditLogScreen token={token} />}
      {screen === "events" && <EventsScreen token={token} />}
      {screen === "tasks" && (
        <TasksScreen
          updateStatus={updateStatus}
          onCheckUpdateNow={handleCheckUpdateNow}
          onTriggerUpdate={handleTriggerUpdate}
          connectivity={connectivity}
          onCheckConnectivityNow={handleCheckConnectivityNow}
        />
      )}
    </AppShell>
  );
}
