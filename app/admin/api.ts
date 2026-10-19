import type { AuditRow, EventIncident, LastArmDisarmEvent, PinSummary, SensorMode, SensorRecord, SensorType, StatusResponse } from "./shared";

function authedHeaders(token: string): HeadersInit {
  return { "x-admin-token": token, "content-type": "application/json" };
}

export async function fetchStatus(): Promise<StatusResponse> {
  const res = await fetch("/api/status");
  if (!res.ok) throw new Error("status fetch failed");
  return res.json();
}

export interface UpdateStatus {
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  checkedAt: string | null;
  error: string | null;
  applyStatus: string | null;
  /** False in Docker, where updating means pulling a new image. */
  selfUpdate: boolean;
}

export async function fetchUpdateStatus(token: string, opts?: { refresh?: boolean }): Promise<UpdateStatus | null> {
  const url = opts?.refresh ? "/api/admin/update?refresh=true" : "/api/admin/update";
  const res = await fetch(url, { headers: authedHeaders(token) });
  if (!res.ok) return null;
  return res.json();
}

export interface DeviceHealth {
  mac: string;
  name: string;
  kind: "sensor" | "camera";
  online: boolean;
  lastSeenAt: string | null;
  batteryPercent: number | null;
  batteryLow: boolean;
  tampered: boolean;
  signalDbm: number | null;
  upSince: string | null;
}

export interface ConnectivityStatus {
  sensorHeartbeatAgeSec: number;
  sensorHeartbeatStale: boolean;
  sensorHeartbeatEverReceived: boolean;
  cameraReachable: boolean | null;
  checkedAt: string | null;
  devices: DeviceHealth[];
  deviceHealthCheckedAt: string | null;
}

export async function fetchConnectivityStatus(token: string, opts?: { refresh?: boolean }): Promise<ConnectivityStatus | null> {
  const url = opts?.refresh ? "/api/admin/connectivity?refresh=true" : "/api/admin/connectivity";
  const res = await fetch(url, { headers: authedHeaders(token) });
  if (!res.ok) return null;
  return res.json();
}

export async function triggerUpdate(token: string, tag?: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/admin/update", {
    method: "POST",
    headers: authedHeaders(token),
    body: JSON.stringify(tag ? { tag } : {}),
  });
  if (res.ok) return { ok: true };
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return { ok: false, error: body?.error };
}

export interface SensorFeedStatus {
  ageSec: number;
  stale: boolean;
  everReceived: boolean;
}

export interface AdminSnapshot {
  pins: PinSummary[];
  audit: AuditRow[];
  sensors: SensorRecord[];
  config: Record<string, string>;
  lastArmDisarm: LastArmDisarmEvent | null;
  sensorFeed: SensorFeedStatus;
}

export async function fetchAdminSnapshot(token: string): Promise<AdminSnapshot | "unauthorized" | "error"> {
  const [pinsRes, auditRes, configRes] = await Promise.all([
    fetch("/api/admin/pins", { headers: authedHeaders(token) }),
    fetch("/api/admin/audit?limit=50", { headers: authedHeaders(token) }),
    fetch("/api/admin/config", { headers: authedHeaders(token) }),
  ]);
  if (pinsRes.status === 401 || auditRes.status === 401 || configRes.status === 401) {
    return "unauthorized";
  }
  // A 429 or 5xx has a JSON error body with no pins/audit; passing that on would unmount the admin tree.
  if (!pinsRes.ok || !auditRes.ok || !configRes.ok) {
    return "error";
  }
  const pinsBody = (await pinsRes.json()) as { pins: PinSummary[] };
  const auditBody = (await auditRes.json()) as { audit: AuditRow[] };
  const configBody = (await configRes.json()) as {
    config: Record<string, string>;
    sensors: SensorRecord[];
    lastArmDisarm: LastArmDisarmEvent | null;
    sensorFeed: SensorFeedStatus;
  };
  return {
    pins: pinsBody.pins,
    audit: auditBody.audit,
    sensors: configBody.sensors,
    config: configBody.config,
    lastArmDisarm: configBody.lastArmDisarm,
    sensorFeed: configBody.sensorFeed,
  };
}

/** One page of the Audit log admin screen's own paginated table (see AuditLogScreen) — distinct from fetchAuditWindow below, which pages internally to build a wider aggregate. */
export async function fetchAuditPage(token: string, limit: number, before?: number): Promise<AuditRow[]> {
  const url = before ? `/api/admin/audit?limit=${limit}&before=${before}` : `/api/admin/audit?limit=${limit}`;
  const res = await fetch(url, { headers: authedHeaders(token) });
  if (!res.ok) return [];
  const body = (await res.json()) as { audit: AuditRow[] };
  return body.audit;
}

/** A single sensor's own trip history, most recent first — the Sensors screen's detail pane, via the audit route's sensorId filter (see lib/services/audit.ts's listAudit). */
export async function fetchSensorTrips(token: string, unifiId: string, limit: number): Promise<AuditRow[]> {
  const res = await fetch(`/api/admin/audit?limit=${limit}&sensorId=${encodeURIComponent(unifiId)}`, {
    headers: authedHeaders(token),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { audit: AuditRow[] };
  return body.audit;
}

const AUDIT_WINDOW_PAGE_LIMIT = 200;
const AUDIT_WINDOW_MAX_PAGES = 8;

/**
 * Pages through /api/admin/audit (via `before`) to cover roughly `days` of
 * history for the Overview heatmap — a client-side reduce over a wider
 * window, per DOCS-ALIGNMENT.md item 5, rather than a new aggregate endpoint.
 * Bounded to AUDIT_WINDOW_MAX_PAGES so a very chatty audit log can't turn
 * this into an unbounded fetch loop.
 */
export async function fetchAuditWindow(token: string, days: number): Promise<AuditRow[]> {
  const cutoff = Date.now() - days * 86_400_000;
  const rows: AuditRow[] = [];
  let before: number | undefined;

  for (let page = 0; page < AUDIT_WINDOW_MAX_PAGES; page++) {
    const url = before
      ? `/api/admin/audit?limit=${AUDIT_WINDOW_PAGE_LIMIT}&before=${before}`
      : `/api/admin/audit?limit=${AUDIT_WINDOW_PAGE_LIMIT}`;
    const res = await fetch(url, { headers: authedHeaders(token) });
    if (!res.ok) break;
    const body = (await res.json()) as { audit: AuditRow[] };
    if (body.audit.length === 0) break;

    rows.push(...body.audit);
    const oldest = body.audit[body.audit.length - 1];
    if (new Date(oldest.ts).getTime() < cutoff) break;
    if (body.audit.length < AUDIT_WINDOW_PAGE_LIMIT) break;
    before = oldest.id;
  }
  return rows;
}

/** Incidents for the Events screen — sensor trips while armed, already grouped server-side (see lib/services/audit.ts). */
export async function fetchEventIncidents(token: string, limit?: number): Promise<EventIncident[]> {
  const url = limit ? `/api/admin/events?limit=${limit}` : "/api/admin/events";
  const res = await fetch(url, { headers: authedHeaders(token) });
  if (!res.ok) return [];
  const body = (await res.json()) as { incidents: EventIncident[] };
  return body.incidents;
}

/** `pinTaken` distinguishes the 409 the API returns for a code that already exists (see app/api/admin/pins/route.ts) from a generic failure, so the UI can say which it was. */
export interface PinWriteResult {
  ok: boolean;
  pinTaken?: boolean;
}

export async function createPin(token: string, label: string, pin: string, isDuress: boolean): Promise<PinWriteResult> {
  const res = await fetch("/api/admin/pins", {
    method: "POST",
    headers: authedHeaders(token),
    body: JSON.stringify({ label, pin, isDuress }),
  });
  return { ok: res.ok, pinTaken: res.status === 409 };
}

export async function revokePin(token: string, id: number): Promise<boolean> {
  const res = await fetch(`/api/admin/pins?id=${id}`, { method: "DELETE", headers: authedHeaders(token) });
  return res.ok;
}

export interface PinUpdate {
  label?: string;
  pin?: string;
  isDuress?: boolean;
}

export async function updatePin(token: string, id: number, update: PinUpdate): Promise<PinWriteResult> {
  const res = await fetch(`/api/admin/pins?id=${id}`, {
    method: "PATCH",
    headers: authedHeaders(token),
    body: JSON.stringify(update),
  });
  return { ok: res.ok, pinTaken: res.status === 409 };
}

export async function saveConfigValues(token: string, config: Record<string, string | number>): Promise<boolean> {
  const res = await fetch("/api/admin/config", {
    method: "PUT",
    headers: authedHeaders(token),
    body: JSON.stringify({ config }),
  });
  return res.ok;
}

/**
 * Downloads the full audit history as CSV. A plain <a href> can't carry the
 * admin token, so this fetches the file as a blob and triggers the save via
 * a throwaway object URL — same pattern as fetchCameraSnapshotUrl below.
 */
export async function downloadAuditLog(token: string): Promise<boolean> {
  const res = await fetch("/api/admin/audit/export", { headers: authedHeaders(token) });
  if (!res.ok) return false;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  return true;
}

/** `name` omitted (not sent as "") leaves the sensor's existing name untouched — the config route's schema requires a non-empty string when present, matching upsertSensor's own "undefined means keep current" semantics. */
export async function saveSensor(
  token: string,
  unifiId: string,
  name: string | undefined,
  mode: SensorMode,
  cameraId: string | null,
  rtspUrl: string | null,
  sensorType: SensorType | null,
): Promise<boolean> {
  const res = await fetch("/api/admin/config", {
    method: "PUT",
    headers: authedHeaders(token),
    body: JSON.stringify({ sensors: [{ unifiId, name, mode, cameraId, rtspUrl, sensorType }] }),
  });
  return res.ok;
}

export async function deleteSensor(token: string, unifiId: string): Promise<boolean> {
  const res = await fetch(`/api/admin/config?unifiId=${encodeURIComponent(unifiId)}`, {
    method: "DELETE",
    headers: authedHeaders(token),
  });
  return res.ok;
}

/**
 * Fetches a camera's live snapshot as a blob URL for an <img> tag — the
 * browser can't hit the Protect API directly (LAN-only, self-signed cert,
 * X-API-KEY shouldn't ship to the client), so this goes through the admin
 * API's proxy route instead. Null on any failure (camera unreachable, bad
 * ID, ...); the caller falls back to a static placeholder.
 */
export async function fetchCameraSnapshotUrl(token: string, cameraId: string): Promise<string | null> {
  const res = await fetch(`/api/admin/cameras/snapshot?cameraId=${encodeURIComponent(cameraId)}`, {
    headers: authedHeaders(token),
  });
  if (!res.ok) return null;
  return URL.createObjectURL(await res.blob());
}

/**
 * Builds the <img src> for a camera's live MJPEG feed (see
 * app/api/admin/cameras/live/route.ts). A plain <img> can't carry the admin
 * token, so this first mints a short-lived, single-use stream token
 * (header-authed) and puts that in the URL instead — see
 * lib/auth/stream-token.ts. Null if go2rtc/the admin API is unreachable; the
 * caller falls back to the static snapshot.
 */
export async function fetchLiveStreamUrl(token: string, cameraId: string): Promise<string | null> {
  const res = await fetch(`/api/admin/cameras/live-token?cameraId=${encodeURIComponent(cameraId)}`, {
    headers: authedHeaders(token),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { token: string };
  return `/api/admin/cameras/live?cameraId=${encodeURIComponent(cameraId)}&token=${encodeURIComponent(body.token)}`;
}

export interface SubmitPinResult {
  ok: boolean;
  lockedOut?: boolean;
  reason?: "sensors_open";
  openSensors?: { id: number; name: string }[];
}

/** Arms directly with no PIN — the admin token is already the gate. See app/api/admin/arm/route.ts. */
export async function armFromAdmin(token: string, force = false): Promise<SubmitPinResult> {
  const res = await fetch("/api/admin/arm", {
    method: "POST",
    headers: authedHeaders(token),
    body: JSON.stringify({ force }),
  });
  if (res.status === 409) {
    const data = (await res.json().catch(() => ({}))) as { reason?: "sensors_open"; openSensors?: { id: number; name: string }[] };
    return { ok: false, reason: data.reason, openSensors: data.openSensors };
  }
  return { ok: res.ok };
}

export async function submitPin(kind: "arm" | "disarm", pin: string, force = false): Promise<SubmitPinResult> {
  const res = await fetch(`/api/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(kind === "arm" ? { pin, force } : { pin }),
  });
  if (res.status === 429) return { ok: false, lockedOut: true };
  if (res.status === 409) {
    const data = (await res.json().catch(() => ({}))) as { reason?: "sensors_open"; openSensors?: { id: number; name: string }[] };
    return { ok: false, reason: data.reason, openSensors: data.openSensors };
  }
  return { ok: res.ok };
}

export type SettingsGroup = "console" | "notifications" | "panel";

export interface SettingsSnapshot {
  secretsKey: "ok" | "missing" | "invalid";
  consoleConfigured: boolean;
  groups: Record<SettingsGroup, { values: Record<string, string | null>; secrets: Record<string, { set: boolean; readable: boolean }> }>;
}

export async function fetchSettings(token: string): Promise<SettingsSnapshot | null> {
  const res = await fetch("/api/admin/settings", { headers: authedHeaders(token) });
  if (!res.ok) return null;
  return res.json();
}

/** Plain field: string sets, null clears. Secret: string replaces, null clears, omitted keeps. */
export async function saveSettingsGroup(
  token: string,
  group: SettingsGroup,
  values: Record<string, string | null>,
): Promise<{ ok: true; settings: SettingsSnapshot } | { ok: false; error: string }> {
  const res = await fetch("/api/admin/settings", {
    method: "PUT",
    headers: authedHeaders(token),
    body: JSON.stringify({ group, values }),
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) return { ok: false, error: body?.error ?? "Saving failed." };
  return { ok: true, settings: body as SettingsSnapshot };
}

export interface SettingsCheckResult {
  name: string;
  status: "ok" | "failed" | "skipped";
  detail: string;
}

/** `channel`: test one notification channel (its id, like "telegram") instead of all of them. */
export async function testSettings(token: string, target: "console" | "notifications", channel?: string): Promise<SettingsCheckResult[] | null> {
  const res = await fetch("/api/admin/settings/test", {
    method: "POST",
    headers: authedHeaders(token),
    body: JSON.stringify({ target, channel }),
  });
  if (!res.ok) return null;
  return ((await res.json()) as { results: SettingsCheckResult[] }).results;
}
