"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type { ConnectivityStatus, DeviceHealth, UpdateStatus } from "./api";
import { EYEBROW, formatApplyStatus, isUpdateApplyInProgress, updateApplyProgressLabel } from "./shared";

function relativeTime(iso: string | null): string {
  if (!iso) return "Never";
  const sec = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return "Just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return `${Math.floor(sec / 86400)}d ago`;
}

/** A device UniFi itself reports as unhealthy — the only signal here that means "broken" rather than "quiet". */
function isDegraded(device: DeviceHealth): boolean {
  return !device.online || device.batteryLow || device.tampered;
}

function describeDevice(device: DeviceHealth): string {
  if (!device.online) return "offline";
  if (device.tampered) return "tampering reported";
  return `low battery${device.batteryPercent != null ? ` ${device.batteryPercent}%` : ""}`;
}

interface TasksScreenProps {
  updateStatus: UpdateStatus | null;
  onCheckUpdateNow: () => Promise<boolean>;
  onTriggerUpdate: () => Promise<void>;
  connectivity: ConnectivityStatus | null;
  onCheckConnectivityNow: () => Promise<boolean>;
}

export function TasksScreen({
  updateStatus,
  onCheckUpdateNow,
  onTriggerUpdate,
  connectivity,
  onCheckConnectivityNow,
}: TasksScreenProps) {
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [checkingConnectivity, setCheckingConnectivity] = useState(false);
  // Optimistic disable for the instant between the click and the server
  // round-trip — the real, authoritative in-progress state is
  // updateStatus.applyStatus (requested:/applying:, see shared.ts), which
  // this defers to as soon as it lands.
  const [triggeringUpdate, setTriggeringUpdate] = useState(false);
  // The request itself (network/auth) failing is distinct from
  // updateStatus.error (a successful request whose *check* failed) — without
  // this, a failed fetch left the button just going back to idle with zero
  // sign anything happened.
  const [updateCheckFailed, setUpdateCheckFailed] = useState(false);
  const [connectivityCheckFailed, setConnectivityCheckFailed] = useState(false);
  const applying = triggeringUpdate || isUpdateApplyInProgress(updateStatus?.applyStatus);
  const progressLabel = updateApplyProgressLabel(updateStatus?.applyStatus, updateStatus?.latestVersion ?? null);
  const applyStatusInfo = formatApplyStatus(updateStatus?.applyStatus);
  const degradedDevices = (connectivity?.devices ?? []).filter(isDegraded);

  async function handleCheckUpdateNow() {
    setCheckingUpdate(true);
    setUpdateCheckFailed(false);
    const ok = await onCheckUpdateNow();
    setUpdateCheckFailed(!ok);
    setCheckingUpdate(false);
  }

  async function handleTriggerUpdate() {
    setTriggeringUpdate(true);
    await onTriggerUpdate();
    setTriggeringUpdate(false);
  }

  async function handleCheckConnectivityNow() {
    setCheckingConnectivity(true);
    setConnectivityCheckFailed(false);
    const ok = await onCheckConnectivityNow();
    setConnectivityCheckFailed(!ok);
    setCheckingConnectivity(false);
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-4 p-4 md:p-7">
      <Card>
        <div className="flex items-start gap-5 border-b border-border p-5.5">
          <div className="flex flex-1 flex-col gap-2.5">
            <div className={EYEBROW}>Update check</div>
            <div className="flex items-baseline gap-2 text-body-s text-foreground">
              <span className="text-muted-foreground">Running</span>
              <span className="font-mono">{updateStatus?.currentVersion ?? "n/a"}</span>
              <span aria-hidden="true" className="text-muted-foreground">
                →
              </span>
              <span className="text-muted-foreground">Latest</span>
              <span className="font-mono">{updateStatus?.latestVersion ?? "n/a"}</span>
              {updateStatus?.latestVersion && (
                <span className="text-xs text-muted-foreground">
                  {updateStatus.updateAvailable ? "(update available)" : "(up to date)"}
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground">
              {`Checked hourly against GitHub Releases · last checked ${relativeTime(updateStatus?.checkedAt ?? null)}`}
            </div>
            {updateStatus?.error && (
              <p className="m-0 text-body-s leading-[1.6] text-destructive">{updateStatus.error}</p>
            )}
            {updateCheckFailed && (
              <p className="m-0 text-body-s leading-[1.6] text-destructive">
                Check now failed. The request to the server didn&apos;t go through. Try reloading the page.
              </p>
            )}
            {applyStatusInfo && (
              <p
                className={`m-0 text-body-s leading-[1.6] ${applyStatusInfo.tone === "destructive" ? "text-destructive" : "text-muted-foreground"}`}
              >
                {applyStatusInfo.text}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3.5 p-5.5">
          <Button variant="secondary" type="button" disabled={checkingUpdate} onClick={handleCheckUpdateNow}>
            {checkingUpdate ? "Checking…" : "Check now"}
          </Button>
          {updateStatus?.selfUpdate !== false && (
            <Button type="button" disabled={!updateStatus?.updateAvailable || applying} onClick={handleTriggerUpdate}>
              {progressLabel ??
                `Update to latest${updateStatus?.latestVersion ? ` (${updateStatus.latestVersion})` : ""}`}
            </Button>
          )}
        </div>
        {updateStatus?.selfUpdate === false && (
          <p className="m-0 px-5.5 pb-5.5 text-xs text-muted-foreground">
            {
              "Running in Docker. To update, pull the new image and recreate the container: docker compose pull && docker compose up -d."
            }
          </p>
        )}
        {updateStatus?.selfUpdate !== false && !updateStatus?.updateAvailable && !applying && (
          <p className="m-0 px-5.5 pb-5.5 text-xs text-muted-foreground">
            {updateStatus?.error
              ? "Update to latest is disabled until a check succeeds."
              : "Update to latest is disabled. Already on the latest known version."}
          </p>
        )}
      </Card>

      <Card>
        <div className="flex items-start gap-5 border-b border-border p-5.5">
          <div className="flex flex-1 flex-col gap-1.5">
            <div className={EYEBROW}>Connectivity watchdog</div>
            <p className="m-0 text-body-s leading-[1.6] text-muted-foreground">
              {
                "Polls sensor heartbeat and the default camera every 5 minutes, device health from UniFi every 2 hours. "
              }
              {connectivity == null
                ? ""
                : connectivity.sensorHeartbeatStale
                  ? connectivity.sensorHeartbeatEverReceived
                    ? "Sensor heartbeat is stale: no webhook has arrived recently."
                    : "No sensor webhook has been received since this server started. Check the UniFi Alarm Manager outbound webhook config and this server's logs for rejected requests."
                  : "Sensor heartbeat is current."}
              {connectivity?.cameraReachable === false && " Default camera is unreachable."}
              {degradedDevices.length > 0 &&
                ` Devices needing attention: ${degradedDevices.map((d) => `${d.name} (${describeDevice(d)})`).join(", ")}.`}
              {` Last checked: ${relativeTime(connectivity?.checkedAt ?? null)}.`}
            </p>
            {connectivityCheckFailed && (
              <p className="m-0 text-body-s leading-[1.6] text-destructive">
                Check now failed. The request to the server didn&apos;t go through. Try reloading the page.
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3.5 p-5.5">
          <Button
            variant="secondary"
            type="button"
            disabled={checkingConnectivity}
            onClick={handleCheckConnectivityNow}
          >
            {checkingConnectivity ? "Checking…" : "Check now"}
          </Button>
        </div>
      </Card>
    </div>
  );
}
