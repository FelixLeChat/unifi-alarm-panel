"use client";

import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldContent, FieldDescription, FieldLabel, FieldTitle } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Skeleton } from "@/components/ui/skeleton";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { CheckIcon } from "@/components/ui/icons/check";
import { SensorsOffIcon } from "@/components/ui/icons/sensors-off";
import { VideocamIcon } from "@/components/ui/icons/videocam";
import { humanizeAuditEvent } from "./audit-copy";
import { deleteSensor, fetchSensorTrips, saveSensor } from "./api";
import { CameraFeed } from "./CameraFeed";
import { DeleteSensorDialog } from "./DeleteSensorDialog";
import type { SensorFeedStatus } from "./api";
import {
  EYEBROW,
  formatAuditTimestamp,
  sensorHealth,
  TRANSITION,
  useTransientFlag,
  type AuditRow,
  type SensorHealth,
  type SensorMode,
  type SensorRecord,
  type SensorType,
} from "./shared";

const TRIP_HISTORY_LIMIT = 20;

interface SensorsScreenProps {
  sensors: SensorRecord[];
  sensorFeed: SensorFeedStatus;
  token: string;
  onSaved: () => void;
}

// Anything else (an http(s) live-view link, a snapshot URL, ...) is a
// paste-the-wrong-thing mistake — catch it here rather than several layers
// deep in a go2rtc/ffmpeg error. Mirrors the server-side check in
// app/api/admin/config/route.ts's zod schema, which is the authoritative one.
const RTSP_URL_PATTERN = /^rtsps?:\/\//;

const MODE_OPTIONS: Array<{ value: SensorMode; label: string; description: string }> = [
  { value: "delayed", label: "Delayed", description: "Entry and exit delays apply before the alarm trips. For doors and motion sensors people pass through." },
  { value: "instant", label: "Instant", description: "Trips the alarm immediately when armed. For windows, tamper, and irregular access points." },
  { value: "ignore", label: "Ignore", description: "Never trips the alarm. Events still appear in the audit log." },
];

const HEALTH_DOT: Record<SensorHealth, string> = {
  green: "bg-success",
  yellow: "bg-warning",
  red: "bg-destructive",
  // Grey, not red: "we can't tell" and "this is broken" are different
  // claims, and only one of them should make someone walk to the door.
  unknown: "bg-muted-foreground",
};

// UniFi's webhook payload can't reliably tell us which physical device sent
// an event (see isCameraTriggerEvent's comment in lib/services/sensors.ts),
// so this is set by whoever installed the sensor, not inferred.
function formatFeedAge(ageSec: number): string {
  if (ageSec < 3600) return `${Math.max(1, Math.round(ageSec / 60))}m`;
  if (ageSec < 48 * 3600) return `${Math.round(ageSec / 3600)}h`;
  return `${Math.round(ageSec / 86_400)}d`;
}

const TYPE_OPTIONS: Array<{ value: SensorType; label: string }> = [
  { value: "motion", label: "Motion" },
  { value: "door", label: "Door (open/close)" },
];

export function SensorsScreen({ sensors, sensorFeed, token, onSaved }: SensorsScreenProps) {
  // /admin/sensors/[unifiId] — the second catch-all segment. Reading it here
  // (rather than threading it down from the [[...screen]] page) keeps the
  // screen router generic; same self-contained URL-sync approach PinsScreen
  // uses for its own sort/filter state.
  const unifiIdFromUrl = useParams<{ screen?: string[] }>().screen?.[1];

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [draftMode, setDraftMode] = useState<SensorMode>("delayed");
  const [draftName, setDraftName] = useState("");
  const [draftCameraId, setDraftCameraId] = useState("");
  const [draftRtspUrl, setDraftRtspUrl] = useState("");
  const [draftSensorType, setDraftSensorType] = useState<SensorType | null>(null);
  const [saving, setSaving] = useState(false);
  const [justSaved, markSaved] = useTransientFlag();
  const [deleteTarget, setDeleteTarget] = useState<SensorRecord | null>(null);
  const [trips, setTrips] = useState<AuditRow[]>([]);
  const [tripsLoading, setTripsLoading] = useState(false);

  const selected = sensors.find((s) => s.id === selectedId) ?? null;
  const selectedHealth = selected ? sensorHealth(selected, sensorFeed.stale) : null;
  const [refreshingSnapshot, setRefreshingSnapshot] = useState(false);
  // Bumped by the Refresh button to force CameraFeed to re-fetch even though
  // selected.cameraId hasn't changed — its own deps wouldn't otherwise
  // notice a request to just re-fetch the same camera.
  const [snapshotRefreshKey, setSnapshotRefreshKey] = useState(0);
  // Same idea, for the trip-history fetch below.
  const [tripsRefreshKey, setTripsRefreshKey] = useState(0);

  useEffect(() => {
    if (selectedId != null || sensors.length === 0) return;
    // Deep-link support: land straight on the sensor named in the URL, if
    // any, and fall back to the first one.
    const fromUrl = unifiIdFromUrl ? sensors.find((s) => s.unifiId === unifiIdFromUrl) : undefined;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSelectedId((fromUrl ?? sensors[0]).id);
  }, [selectedId, sensors, unifiIdFromUrl]);

  // A plain History API call, not next/navigation's router.replace(): this
  // route is an optional catch-all ([[...screen]]), and pushing/replacing to
  // a URL with a different number of segments through Next's router
  // triggers a full remount of the page (confirmed live — AdminPage's own
  // snapshot state and this component's were both observed resetting to
  // their initial values right after a router.replace() call here, wiping
  // an in-progress edit). All that's actually needed is for the address bar
  // (and a future reload) to reflect the selection — selection itself is
  // already driven by local state — so update the URL without going through
  // Next's client-side navigation at all.
  function selectSensor(s: SensorRecord): void {
    setSelectedId(s.id);
    window.history.replaceState(null, "", `/admin/sensors/${encodeURIComponent(s.unifiId)}`);
  }

  useEffect(() => {
    if (selected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDraftMode(selected.mode);
      setDraftName(selected.name);
      setDraftCameraId(selected.cameraId ?? "");
      setDraftRtspUrl(selected.rtspUrl ?? "");
      setDraftSensorType(selected.sensorType);
      // CameraFeed only mounts for a self-mapped camera sensor (see below) —
      // reset this so a stale "loading" from the previously selected sensor
      // can't leave the Refresh button disabled forever on a sensor whose
      // feed never mounts to clear it itself.
      setRefreshingSnapshot(false);
    }
    // Only re-seed the draft when the *selection* changes, not on every
    // sensors reload — otherwise an in-progress edit gets clobbered by the
    // background refresh that follows an unrelated save.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!selected) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clearing stale trips when the selection is cleared, not syncing an external system
      setTrips([]);
      return;
    }
    let cancelled = false;
    setTripsLoading(true);
    fetchSensorTrips(token, selected.unifiId, TRIP_HISTORY_LIMIT)
      .then((rows) => {
        if (!cancelled) setTrips(rows);
      })
      .catch(() => {
        if (!cancelled) setTrips([]);
      })
      .finally(() => {
        if (!cancelled) setTripsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Keyed on the sensor's own id, not the whole `selected` object (which
    // changes reference on every unrelated snapshot refresh) — re-fetching
    // on every keystroke of an in-progress edit would be wasteful.
    // tripsRefreshKey is the Refresh button's own "fetch again" signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.unifiId, token, tripsRefreshKey]);

  const counts = { delayed: 0, instant: 0, ignore: 0 };
  for (const s of sensors) counts[s.mode]++;
  const totalLine = `${sensors.length} sensor${sensors.length === 1 ? "" : "s"}`;
  const breakdownLine = `${counts.delayed} delayed · ${counts.instant} instant · ${counts.ignore} ignored`;

  function handleRefresh() {
    onSaved(); // re-fetches the sensor list (and rest of the admin snapshot)
    setSnapshotRefreshKey((k) => k + 1); // re-fetches the selected sensor's camera snapshot, if any
    setTripsRefreshKey((k) => k + 1); // re-fetches the selected sensor's trip history
  }

  async function handleSave() {
    if (!selected) return;
    const trimmedRtspUrl = draftRtspUrl.trim();
    if (trimmedRtspUrl && !RTSP_URL_PATTERN.test(trimmedRtspUrl)) {
      toast.error("RTSPS URL must start with rtsp:// or rtsps://");
      return;
    }
    setSaving(true);
    const ok = await saveSensor(
      token,
      selected.unifiId,
      draftName.trim() || undefined,
      draftMode,
      draftCameraId.trim() || null,
      trimmedRtspUrl || null,
      draftSensorType,
    );
    setSaving(false);
    if (ok) {
      toast.success("Saved just now");
      markSaved();
      onSaved();
    }
  }

  async function handleConfirmDelete() {
    if (!deleteTarget) return;
    await deleteSensor(token, deleteTarget.unifiId);
    // Picks the next selection (and updates the URL to match) right away,
    // rather than clearing selectedId and waiting on onSaved()'s refetch to
    // land before the default-selection effect above can react to it.
    const remaining = sensors.filter((s) => s.unifiId !== deleteTarget.unifiId);
    const next = remaining[0] ?? null;
    setSelectedId(next?.id ?? null);
    window.history.replaceState(null, "", next ? `/admin/sensors/${encodeURIComponent(next.unifiId)}` : "/admin/sensors");
    setDeleteTarget(null);
    onSaved();
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <div className="flex w-full flex-none flex-col border-b border-border bg-card md:w-[340px] md:border-r md:border-b-0">
        <div className={`${EYEBROW} flex flex-col gap-2 border-b border-border px-4.5 py-3.5`}>
          <div className="flex flex-col gap-1">
            <div>{totalLine}</div>
            <div>{breakdownLine}</div>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshingSnapshot}
            className="w-full flex-none font-sans text-xs tracking-normal text-foreground normal-case"
          >
            {refreshingSnapshot ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {/* One cause, stated once. Every dot below goes grey while this is
            up: a dead feed says nothing about any individual sensor, and
            six red dots for one broken webhook is what sent someone
            hunting the wrong problem for two days. */}
        {sensorFeed.stale && (
          <div className="border-b border-border p-2">
          <Alert>
            <AlertTitle>No sensor events arriving</AlertTitle>
            <AlertDescription>
              {sensorFeed.everReceived
                ? `Last webhook ${formatFeedAge(sensorFeed.ageSec)} ago. Statuses below are unknown until the feed recovers. Check the UniFi Alarm Manager webhook.`
                : `Nothing since this server started ${formatFeedAge(sensorFeed.ageSec)} ago. Check the UniFi Alarm Manager outbound webhook config.`}
            </AlertDescription>
          </Alert>
          </div>
        )}

        {sensors.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <SensorsOffIcon size={20} />
              </EmptyMedia>
              <EmptyTitle>No sensors found</EmptyTitle>
              <EmptyDescription>Sensors register automatically the first time they send a webhook event. Nothing to configure here yet.</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-1 p-2">
            {sensors.map((s) => {
              const isSelected = s.id === selectedId;
              const isCameraTrigger = s.cameraId === s.unifiId;
              const health = sensorHealth(s, sensorFeed.stale);
              return (
                <Item
                  key={s.id}
                  size="sm"
                  variant={isSelected ? "outline" : "default"}
                  render={<button type="button" onClick={() => selectSensor(s)} aria-current={isSelected ? "true" : undefined} />}
                  className={`cursor-pointer text-left ${TRANSITION} ${isSelected ? "bg-emphasis/15" : "hover:bg-emphasis/15"} ${s.mode === "ignore" ? "opacity-60" : ""}`}
                >
                  <ItemMedia>
                    <span
                      title={`${health.reason}. Last tripped: ${s.lastTrippedAt ? formatAuditTimestamp(s.lastTrippedAt) : "never"}`}
                      className={`size-2 flex-none rounded-full ${HEALTH_DOT[health.level]}`}
                    />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{s.name}</ItemTitle>
                    {/* Mode and last trip on separate lines: together they
                        wrapped mid-timestamp in the 340px list column, which
                        read as a broken date rather than a long one. */}
                    <ItemDescription className="font-mono text-body-xs">
                      {s.mode}
                      {s.sensorType ? ` · ${s.sensorType}` : ""}
                    </ItemDescription>
                    <ItemDescription className="font-mono text-body-xs whitespace-nowrap">
                      {s.lastTrippedAt ? `tripped ${formatAuditTimestamp(s.lastTrippedAt)}` : "never tripped"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    {isCameraTrigger ? (
                      <span className={`${EYEBROW} text-muted-foreground`}>Camera</span>
                    ) : (
                      s.cameraId && <VideocamIcon size={16} className="text-muted-foreground" />
                    )}
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        )}
      </div>

      {selected && selectedHealth && (
        <div className="flex min-w-0 flex-1 flex-col gap-5 p-4 md:p-7">
          {selected.cameraId === selected.unifiId && (
            <CameraFeed
              token={token}
              name={selected.name}
              cameraId={selected.cameraId}
              rtspUrl={selected.rtspUrl}
              refreshKey={snapshotRefreshKey}
              onLoadingChange={setRefreshingSnapshot}
            />
          )}

          <div className="flex flex-wrap items-baseline gap-x-3.5 gap-y-1 md:flex-nowrap">
            <h2 className="m-0 min-w-0 font-display text-title-xs leading-[1.1] break-words text-foreground md:flex-none md:whitespace-nowrap">
              {selected.name}
            </h2>
            <span className="flex-none font-mono text-xs whitespace-nowrap text-muted-foreground">{selected.unifiId}</span>
            <span className="flex-none text-xs whitespace-nowrap text-muted-foreground">
              {selected.lastTrippedAt ? `Last tripped ${formatAuditTimestamp(selected.lastTrippedAt)}` : "Never tripped"}
            </span>
          </div>

          {/* The dot's reasoning, spelled out — plus what UniFi itself says
              about the device, which is the only signal here that means
              "broken" rather than "quiet". */}
          <div className="-mt-2.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className={`h-[7px] w-[7px] flex-none ${HEALTH_DOT[selectedHealth.level]}`} />
            <span>{selectedHealth.reason}</span>
            <span>{`· ${selected.tripCount24h} trip${selected.tripCount24h === 1 ? "" : "s"} in the last 24h`}</span>
            {selected.device && (
              <span className="text-muted-foreground">
                {`· UniFi: ${selected.device.online ? "online" : "offline"}`}
                {selected.device.signalDbm != null ? ` · ${selected.device.signalDbm} dBm` : ""}
                {selected.device.batteryPercent != null ? ` · battery ${selected.device.batteryPercent}%` : ""}
                {selected.device.lastSeenAt ? ` · last seen ${formatAuditTimestamp(selected.device.lastSeenAt)}` : ""}
              </span>
            )}
          </div>

          {selected.cameraId === selected.unifiId && (
            <p className="m-0 -mt-2.5 text-xs leading-[1.5] text-muted-foreground">
              {'This entry is a camera\'s own motion trigger, not a separate physical sensor. Its snapshot or live feed above is wired to itself automatically. Change "Protect camera ID" below only if you want a different camera\'s view attached instead.'}
            </p>
          )}

          <RadioGroup aria-label="Sensor mode" value={draftMode} onValueChange={(v) => setDraftMode(v as SensorMode)} className="gap-2">
            {MODE_OPTIONS.map((opt) => (
              <FieldLabel key={opt.value} htmlFor={`sensor-mode-${opt.value}`} className="has-data-checked:bg-emphasis/15">
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldTitle>{opt.label}</FieldTitle>
                    <FieldDescription>{opt.description}</FieldDescription>
                  </FieldContent>
                  <RadioGroupItem value={opt.value} id={`sensor-mode-${opt.value}`} />
                </Field>
              </FieldLabel>
            ))}
          </RadioGroup>

          <div className="flex flex-wrap items-end gap-4">
            <Field className="w-[180px]">
              <FieldLabel htmlFor="sensor-type" className={EYEBROW}>
                Event type
              </FieldLabel>
              <NativeSelect
                id="sensor-type"
                value={draftSensorType ?? ""}
                onChange={(e) => setDraftSensorType((e.target.value || null) as SensorType | null)}
                >
                <NativeSelectOption value="">Not set</NativeSelectOption>
                {TYPE_OPTIONS.map((opt) => (
                  <NativeSelectOption key={opt.value} value={opt.value}>
                    {opt.label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field className="w-[200px]">
              <FieldLabel htmlFor="sensor-name" className={EYEBROW}>
                Name
              </FieldLabel>
              <Input
                id="sensor-name"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={selected.unifiId}
                className="w-[200px] text-body-s"
              />
            </Field>
            <Field className="w-[220px]">
              <FieldLabel htmlFor="sensor-camera" className={EYEBROW}>
                Protect camera ID
              </FieldLabel>
              <Input
                id="sensor-camera"
                value={draftCameraId}
                onChange={(e) => setDraftCameraId(e.target.value)}
                placeholder="Not mapped"
                className="w-[220px] font-mono text-body-s"
              />
            </Field>
            <Field className="w-[320px]">
              <FieldLabel htmlFor="sensor-rtsp" className={EYEBROW}>
                RTSPS URL (live feed)
              </FieldLabel>
              <Input
                id="sensor-rtsp"
                value={draftRtspUrl}
                onChange={(e) => setDraftRtspUrl(e.target.value)}
                placeholder="Not live-streamed"
                title="Must start with rtsp:// or rtsps://"
                className="w-[320px] font-mono text-body-s"
              />
            </Field>
            <Button onClick={handleSave} disabled={saving} className="w-[124px]">
              {justSaved ? (
                <span className="inline-flex items-center gap-1.5">
                  <CheckIcon size={12} />
                  Saved
                </span>
              ) : (
                "Save sensor"
              )}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDeleteTarget(selected)}
              className="text-destructive"
            >
              Delete sensor
            </Button>
          </div>

          <div id="sensor-trip-history" className="flex flex-col gap-2">
            <div className={EYEBROW}>{`Last ${TRIP_HISTORY_LIMIT} events`}</div>
            {tripsLoading ? (
              <div className="flex max-w-180 flex-col gap-2">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : trips.length === 0 ? (
              <p className="m-0 text-xs text-muted-foreground">No events recorded for this sensor yet.</p>
            ) : (
              <Card className="flex max-w-180 flex-col">
                {trips.map((row, i) => (
                  <div
                    key={row.id}
                    className={`flex items-baseline gap-3 px-4 py-2 text-xs ${i < trips.length - 1 ? "border-b border-border" : ""}`}
                  >
                    <span className="flex-none font-mono text-muted-foreground">{formatAuditTimestamp(row.ts)}</span>
                    <span className="text-foreground">{humanizeAuditEvent(row.event, row.detail)}</span>
                  </div>
                ))}
              </Card>
            )}
          </div>
        </div>
      )}

      <DeleteSensorDialog name={deleteTarget?.name ?? null} onCancel={() => setDeleteTarget(null)} onConfirm={handleConfirmDelete} />
    </div>
  );
}
