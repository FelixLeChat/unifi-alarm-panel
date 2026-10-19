"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Logo, Logomark } from "@/components/ui/logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { armFromAdmin, type UpdateStatus } from "./api";
import { ArmPinDialog } from "./ArmPinDialog";
import {
  EYEBROW,
  findLastActor,
  formatDayClockTime,
  isUpdateApplyInProgress,
  updateApplyProgressLabel,
  type AlarmStateName,
  type AuditRow,
  type Screen,
  type SensorRecord,
  type StatusResponse,
} from "./shared";
import { LogoutIcon } from "@/components/ui/icons/logout";
import { MonitoringIcon } from "@/components/ui/icons/monitoring";
import { PinIcon } from "@/components/ui/icons/pin";
import { ReceiptLongIcon } from "@/components/ui/icons/receipt-long";
import { SensorsIcon } from "@/components/ui/icons/sensors";
import { SettingsIcon } from "@/components/ui/icons/settings";
import { TimerIcon } from "@/components/ui/icons/timer";
import { VideocamIcon } from "@/components/ui/icons/videocam";
import type { IconProps } from "@/components/ui/icons/icon-props";

const NAV: Array<{ id: Screen; label: string; icon: ComponentType<IconProps> }> = [
  { id: "overview", label: "Overview", icon: MonitoringIcon },
  { id: "sensors", label: "Sensors", icon: SensorsIcon },
  { id: "pins", label: "PINs", icon: PinIcon },
  { id: "delays", label: "Delays", icon: TimerIcon },
  { id: "audit", label: "Audit log", icon: ReceiptLongIcon },
  { id: "events", label: "Events", icon: VideocamIcon },
  { id: "tasks", label: "Tasks", icon: TimerIcon },
  { id: "settings", label: "Settings", icon: SettingsIcon },
];

const PAGE_TITLES: Record<Screen, string> = {
  overview: "Overview",
  sensors: "Sensors",
  pins: "PINs",
  delays: "Delays",
  audit: "Audit log",
  events: "Events",
  tasks: "Tasks",
  settings: "Settings",
};

function armPillTreatment(state: AlarmStateName) {
  if (state === "ALARM") {
    return {
      border: "border-transparent",
      bg: "bg-destructive",
      label: "text-destructive-foreground",
      meta: "text-destructive-foreground",
      dot: "bg-destructive-foreground",
    };
  }
  if (state === "DISARMED") {
    return {
      border: "border-border",
      bg: "bg-secondary",
      label: "text-muted-foreground",
      meta: "text-muted-foreground",
      dot: "bg-muted-foreground",
    };
  }
  // ARMING, ARMED, ENTRY_DELAY share the emphasis treatment.
  return {
    border: "border-emphasis",
    bg: "bg-emphasis/15",
    label: "text-foreground",
    meta: "text-foreground",
    dot: "bg-emphasis",
  };
}

/**
 * The header pill's remainingSec otherwise only moves once every ~2s poll
 * (see page.tsx's status effect), which reads as frozen-then-jumping rather
 * than counting down. Counts down locally against a wall-clock deadline
 * (a throttled tab can't fall behind) and only moves that deadline when a
 * poll disagrees by more than 1s, so poll jitter can't make it flip 8, 9, 8.
 * Same approach as the kiosk's startCountdown (public/panel.js).
 */
const secondsUntil = (deadline: number) => Math.max(0, Math.ceil((deadline - Date.now()) / 1000));

function useDisplayRemainingSec(serverRemainingSec: number | null): number | null {
  const [deadline, setDeadline] = useState<number | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reconciling the local deadline with a fresh server value on every poll is the point (see the doc comment above)
    setDeadline((prev) => {
      if (serverRemainingSec === null) return null;
      if (prev !== null && Math.abs(secondsUntil(prev) - serverRemainingSec) <= 1) return prev;
      return Date.now() + serverRemainingSec * 1000;
    });
  }, [serverRemainingSec]);

  useEffect(() => {
    if (deadline === null) return;
    let last = secondsUntil(deadline);
    const id = setInterval(() => {
      const now = secondsUntil(deadline);
      if (now !== last) {
        last = now;
        setTick((t) => t + 1);
      }
    }, 200);
    return () => clearInterval(id);
  }, [deadline]);

  // Until the deadline effect has run (first render of a fresh countdown) show the server value, not a stale or empty one.
  if (serverRemainingSec === null) return null;
  return deadline === null ? serverRemainingSec : secondsUntil(deadline);
}

function armLabel(state: AlarmStateName, remainingSec: number | null, triggeredSensorName: string | null): string {
  switch (state) {
    case "DISARMED":
      return "Disarmed";
    case "ARMED":
      return "Armed";
    case "ARMING":
      return `Arming · ${remainingSec ?? 0}s`;
    case "ENTRY_DELAY":
      return `Entry delay${triggeredSensorName ? `: ${triggeredSensorName}` : ""} · ${remainingSec ?? 0}s`;
    case "ALARM":
      return triggeredSensorName ? `ALARM: ${triggeredSensorName}` : "ALARM";
  }
}

interface AppShellProps {
  screen: Screen;
  onScreenChange: (screen: Screen) => void;
  onLogout: () => void;
  status: StatusResponse | null;
  audit: AuditRow[];
  sensors: SensorRecord[];
  onArmDisarmSuccess: () => void;
  updateStatus: UpdateStatus | null;
  onTriggerUpdate: () => Promise<void>;
  token: string;
  children: React.ReactNode;
}

export function AppShell({
  screen,
  onScreenChange,
  onLogout,
  status,
  audit,
  sensors,
  onArmDisarmSuccess,
  updateStatus,
  onTriggerUpdate,
  token,
  children,
}: AppShellProps) {
  const [pinDialogOpen, setPinDialogOpen] = useState(false);
  const armButtonRef = useRef<HTMLButtonElement>(null);
  // Optimistic disable for the instant between the click and the server
  // round-trip — see the matching comment in TasksScreen.tsx.
  const [triggeringUpdate, setTriggeringUpdate] = useState(false);
  const [arming, setArming] = useState(false);
  // Non-null once a no-force arm attempt comes back 409 sensors_open — same
  // tap-to-confirm shape as the kiosk's /api/panel/arm flow (public/panel.js),
  // just without a PIN step: the admin token is already the gate.
  const [armOpenSensors, setArmOpenSensors] = useState<{ id: number; name: string }[] | null>(null);

  async function handleTriggerUpdate() {
    setTriggeringUpdate(true);
    await onTriggerUpdate();
    setTriggeringUpdate(false);
  }

  async function handleArmClick() {
    setArming(true);
    const result = await armFromAdmin(token, false);
    setArming(false);
    if (result.reason === "sensors_open") {
      setArmOpenSensors(result.openSensors ?? []);
      return;
    }
    if (result.ok) onArmDisarmSuccess();
  }

  async function handleForceArm() {
    setArmOpenSensors(null);
    setArming(true);
    const result = await armFromAdmin(token, true);
    setArming(false);
    if (result.ok) onArmDisarmSuccess();
  }

  const state = status?.state ?? "DISARMED";
  const displayRemainingSec = useDisplayRemainingSec(status?.remainingSec ?? null);
  const pill = armPillTreatment(state);
  const triggeredSensorName = status?.triggeredBy
    ? (sensors.find((s) => s.unifiId === status.triggeredBy?.sensorId)?.name ?? status.triggeredBy.sensorId)
    : null;
  const actor = findLastActor(audit, state === "DISARMED" ? "disarmed" : "armed");
  const meta = status ? `since ${formatDayClockTime(status.since)}${actor ? ` · ${actor}` : ""}` : "";
  const kind = state === "DISARMED" ? "arm" : "disarm";

  return (
    <SidebarProvider>
      <Sidebar collapsible="icon" role="complementary" aria-label="Sidebar">
        <SidebarHeader className="gap-2.5 px-5 pt-6 pb-5 group-data-[collapsible=icon]:px-2">
          <Logo className="h-7 self-start text-foreground group-data-[collapsible=icon]:hidden" />
          <Logomark className="hidden size-6 text-foreground group-data-[collapsible=icon]:block" />
          <div className={`${EYEBROW} group-data-[collapsible=icon]:hidden`}>For UniFi Protect</div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <nav aria-label="Admin screens">
              <SidebarMenu>
                {NAV.map((item) => (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton
                      isActive={item.id === screen}
                      tooltip={item.label}
                      aria-current={item.id === screen ? "page" : undefined}
                      onClick={() => onScreenChange(item.id)}
                    >
                      <item.icon size={19} />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="gap-1.5 border-t border-sidebar-border px-5 py-4 group-data-[collapsible=icon]:px-2">
          <SidebarMenuButton size="sm" tooltip="Log out" onClick={onLogout} className="px-0 font-medium">
            <LogoutIcon size={15} />
            <span>Log out</span>
          </SidebarMenuButton>
        </SidebarFooter>
      </Sidebar>

      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-5 flex min-h-16 flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b border-border bg-card px-4 py-2 md:px-7">
          <SidebarTrigger className="-ml-2" />
          <h1 className="m-0 font-display text-title-xs leading-none text-foreground">{PAGE_TITLES[screen]}</h1>
          <div className="flex w-full flex-wrap items-center gap-2 md:ml-auto md:w-auto md:flex-nowrap md:gap-4">
            {updateStatus?.updateAvailable && updateStatus.selfUpdate !== false && (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={handleTriggerUpdate}
                disabled={triggeringUpdate || isUpdateApplyInProgress(updateStatus.applyStatus)}
              >
                {updateApplyProgressLabel(updateStatus.applyStatus, updateStatus.latestVersion) ??
                  `Update available: ${updateStatus.latestVersion}`}
              </Button>
            )}
            <div
              className={`flex min-w-0 flex-1 items-center gap-2 rounded-lg border px-3 py-1.5 md:flex-none ${pill.border} ${pill.bg}`}
            >
              <span className={`h-2 w-2 flex-none ${pill.dot}`} />
              <span className={`font-mono text-xs font-medium tracking-widest uppercase ${pill.label}`}>
                {armLabel(state, displayRemainingSec, triggeredSensorName)}
              </span>
              <span className={`text-xs ${pill.meta}`}>{meta}</span>
            </div>
            <Button
              ref={armButtonRef}
              onClick={kind === "arm" ? handleArmClick : () => setPinDialogOpen(true)}
              disabled={kind === "arm" && arming}
            >
              {kind === "arm" ? "Arm system" : "Disarm"}
            </Button>
          </div>
        </header>

        {children}
      </SidebarInset>

      <ArmPinDialog
        open={pinDialogOpen}
        kind="disarm"
        finalFocus={armButtonRef}
        onClose={() => setPinDialogOpen(false)}
        onSuccess={() => {
          setPinDialogOpen(false);
          onArmDisarmSuccess();
        }}
      />

      <AlertDialog open={armOpenSensors !== null} onOpenChange={(next) => !next && setArmOpenSensors(null)}>
        <AlertDialogContent finalFocus={armButtonRef} className="w-[340px] max-w-[calc(100%-2rem)]">
          <AlertDialogHeader>
            <AlertDialogTitle className="font-display text-title-xs font-normal text-foreground">
              Door open. Arm anyway?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {armOpenSensors && armOpenSensors.length > 0
                ? `Still open: ${armOpenSensors.map((s) => s.name).join(", ")}.`
                : "A door is still open."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction type="button" disabled={arming} onClick={handleForceArm}>
              Arm anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SidebarProvider>
  );
}
