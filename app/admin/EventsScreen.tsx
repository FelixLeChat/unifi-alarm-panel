"use client";

import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { useEffect, useState } from "react";
import { fetchEventIncidents } from "./api";
import { CameraFeed } from "./CameraFeed";
import { formatAuditTimestamp, TRANSITION, type EventIncident } from "./shared";
import { KeyboardArrowDownIcon } from "@/components/ui/icons/keyboard-arrow-down";

interface EventsScreenProps {
  token: string;
}

function durationLabel(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.round(min / 60)}h`;
}

export function EventsScreen({ token }: EventsScreenProps) {
  const [incidents, setIncidents] = useState<EventIncident[] | null>(null);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchEventIncidents(token).then((rows) => {
      if (!cancelled) setIncidents(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="flex max-w-[900px] flex-col gap-4 p-4 md:p-7">
      <p className="m-0 text-xs leading-[1.5] text-muted-foreground">
        Sensor trips while the system is armed, grouped into one incident per rolling 5-minute window so one continuous
        trip doesn&apos;t splinter into many rows. For case management, use UniFi Protect directly. This is a quick
        &quot;what just happened&quot; glance, not a record of every raw event (see the Audit log for that).
      </p>

      {incidents === null ? (
        <div className="flex flex-col gap-3" aria-busy="true">
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
          <Skeleton className="h-16 w-full rounded-lg" />
        </div>
      ) : incidents.length === 0 ? (
        <Empty className="rounded-lg border">
          <EmptyHeader>
            <EmptyTitle>No sensor trips while armed yet</EmptyTitle>
            <EmptyDescription>Trips show up here when a sensor opens while the system is armed.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="flex flex-col gap-3">
          {incidents.map((incident) => {
            const isOpen = expandedId === incident.id;
            const ongoing = incident.triggeredAlarm && !incident.resolvedAt;
            const sensorNames = incident.sensors.map((s) => s.sensorName).join(", ") || "Unknown sensor";
            return (
              <Card key={incident.id}>
                <button
                  type="button"
                  onClick={() => setExpandedId(isOpen ? null : incident.id)}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left"
                >
                  <Badge variant={ongoing ? "destructive" : incident.triggeredAlarm ? "outline" : "secondary"} className="flex-none">
                    {ongoing ? "Alarm ongoing" : incident.triggeredAlarm ? "Alarm" : "Entry delay"}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{sensorNames}</div>
                    <div className="mt-0.5 font-mono text-body-xs text-muted-foreground">
                      {formatAuditTimestamp(incident.startedAt)}
                      {incident.resolvedAt
                        ? ` · resolved ${durationLabel(new Date(incident.resolvedAt).getTime() - new Date(incident.startedAt).getTime())} later${
                            incident.resolvedBy ? ` by ${incident.resolvedBy}` : ""
                          }`
                        : ongoing
                          ? " · not yet resolved"
                          : ""}
                    </div>
                  </div>
                  <KeyboardArrowDownIcon
                    size={16}
                    className={`flex-none text-muted-foreground ${TRANSITION} ${isOpen ? "rotate-180" : ""}`}
                  />
                </button>

                {isOpen && (
                  <div className="flex flex-col gap-4 border-t border-border px-4 py-4">
                    {incident.sensors.length === 0 ? (
                      <p className="m-0 text-xs text-muted-foreground">No sensor identified for this incident.</p>
                    ) : (
                      incident.sensors.map((s) => (
                        <div key={s.sensorId} className="flex flex-col gap-2">
                          <div className="text-xs font-medium text-foreground">
                            {s.sensorName}: {s.tripCount} trip{s.tripCount === 1 ? "" : "s"}
                          </div>
                          {s.cameraId ? (
                            <CameraFeed token={token} name={s.sensorName} cameraId={s.cameraId} rtspUrl={s.rtspUrl} />
                          ) : (
                            <p className="m-0 text-xs text-muted-foreground">No camera mapped to this sensor.</p>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
