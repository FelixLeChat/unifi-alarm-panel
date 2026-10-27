export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { listEventIncidents } from "@/lib/services/audit";
import { listSensors } from "@/lib/services/sensors";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 30;

export async function GET(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

  const db = getDb();
  const sensorsById = new Map(listSensors(db).map((s) => [s.unifiId, s]));
  const incidents = listEventIncidents(db, limit).map((incident) => ({
    ...incident,
    sensors: incident.sensors.map((s) => {
      const sensor = sensorsById.get(s.sensorId);
      return {
        ...s,
        sensorName: sensor?.name ?? s.sensorId,
        cameraId: sensor?.cameraId ?? null,
        rtspUrl: sensor?.rtspUrl ?? null,
      };
    }),
  }));

  return NextResponse.json({ incidents });
}
