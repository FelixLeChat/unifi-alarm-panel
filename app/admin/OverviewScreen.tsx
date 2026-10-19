"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  buildHeatmap,
  EYEBROW,
  formatClockTime,
  relativeDay,
  type AuditRow,
  type LastArmDisarmEvent,
  type Screen,
  type SensorRecord,
  type StatusResponse,
} from "./shared";

interface OverviewScreenProps {
  lastArmDisarm: LastArmDisarmEvent | null;
  auditWindow: AuditRow[] | null;
  status: StatusResponse | null;
  sensors: SensorRecord[];
  config: Record<string, string>;
  onNavigate: (screen: Screen) => void;
}

const LEVEL_BG = ["bg-secondary", "bg-emphasis/25", "bg-emphasis/55", "bg-emphasis"];

function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

export function OverviewScreen({
  lastArmDisarm,
  auditWindow,
  status,
  sensors,
  config,
  onNavigate,
}: OverviewScreenProps) {
  const lastArmValue = lastArmDisarm
    ? `${lastArmDisarm.event === "armed" ? "Armed" : "Disarmed"} ${formatClockTime(lastArmDisarm.ts)}`
    : "n/a";
  const lastArmMeta = lastArmDisarm
    ? `${relativeDay(lastArmDisarm.ts)} · ${lastArmDisarm.actorLabel ?? "Controller"}`
    : "No arm/disarm events yet";

  // current_state is only ever set once sensorOpenEventTypes/sensorClosedEventTypes
  // are configured (see lib/services/sensors.ts's updateSensorState) — until
  // then every sensor's currentState stays null, and "0 open" would be a lie,
  // not a fact, so the card keeps saying it isn't tracked instead of showing a
  // misleadingly confident zero.
  const doorSensors = sensors.filter((s) => s.sensorType === "door");
  const trackingConfigured = Boolean(config.sensorOpenEventTypes || config.sensorClosedEventTypes);
  const openDoorSensors = doorSensors.filter((s) => s.currentState === "open");
  const openTracked = trackingConfigured && doorSensors.length > 0;
  const openValue = openTracked ? String(openDoorSensors.length) : "n/a";
  const openMeta =
    doorSensors.length === 0
      ? "No door sensors classified yet. View sensors"
      : !trackingConfigured
        ? "Live sensor state isn't tracked yet. View sensors"
        : openDoorSensors.length === 0
          ? `All ${doorSensors.length} door${doorSensors.length === 1 ? "" : "s"} closed. View sensors`
          : `${openDoorSensors.map((s) => s.name).join(", ")}. View sensors`;

  const heatCols = buildHeatmap(auditWindow ?? []);

  return (
    <div className="flex flex-col gap-6 p-4 md:p-7">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Card className="flex flex-col gap-2.5 px-5.5 py-5">
          <div className={EYEBROW}>Last armed / disarmed</div>
          <div className="font-display text-title-xs leading-[1.1] text-foreground">{lastArmValue}</div>
          <div className="text-xs text-muted-foreground">{lastArmMeta}</div>
        </Card>
        <Card className="flex flex-col gap-2.5 px-5.5 py-5">
          <div className={EYEBROW}>Open right now</div>
          <div className="font-display text-title-xs leading-[1.1] text-foreground">{openValue}</div>
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={() => onNavigate("sensors")}
            className="h-auto justify-start p-0 text-xs"
          >
            {openMeta}
          </Button>
        </Card>
        <Card className="flex flex-col gap-2.5 px-5.5 py-5">
          <div className={EYEBROW}>Controller uptime</div>
          <div className="font-display text-title-xs leading-[1.1] text-foreground">
            {status ? formatUptime(status.uptimeSec) : "n/a"}
          </div>
          <div className="text-xs text-muted-foreground">{status ? `Running ${status.version}` : "Not connected"}</div>
        </Card>
      </div>

      <Card className="flex flex-col gap-4 p-5.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-2">
          <div className={EYEBROW}>Arm / disarm activity · last 26 weeks</div>
          <div className="ml-auto flex items-center gap-1.5 text-body-xs text-muted-foreground">
            Less
            <span className="h-2.5 w-2.5 border border-border bg-secondary box-border" />
            <span className="h-2.5 w-2.5 bg-emphasis/25" />
            <span className="h-2.5 w-2.5 bg-emphasis/55" />
            <span className="h-2.5 w-2.5 bg-emphasis" />
            More
          </div>
        </div>
        <div className="overflow-x-auto">
          <div className="grid w-max grid-flow-col grid-rows-7 gap-0.75" style={{ gridAutoColumns: "11px" }}>
            {heatCols.map((col) =>
              col.map((cell) => (
                <span
                  key={cell.date}
                  title={`${cell.date}: ${cell.count} arm/disarm event${cell.count === 1 ? "" : "s"}`}
                  className={`h-[11px] w-[11px] ${LEVEL_BG[cell.level]} ${cell.level === 0 ? "box-border border border-border" : ""}`}
                />
              )),
            )}
          </div>
        </div>
        <div className="text-xs text-muted-foreground">
          {
            "Each column is a week, Monday at the top. Weekday arm/disarm is routine; anything on a weekend is worth a look in the audit log."
          }
        </div>
      </Card>
    </div>
  );
}
