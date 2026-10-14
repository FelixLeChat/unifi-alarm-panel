export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { listAudit } from "@/lib/services/audit";

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export async function GET(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const url = new URL(req.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Number.isInteger(limitParam) && limitParam > 0 ? Math.min(limitParam, MAX_LIMIT) : DEFAULT_LIMIT;

  const beforeParam = url.searchParams.get("before");
  const before = beforeParam ? Number(beforeParam) : undefined;
  if (before !== undefined && (!Number.isInteger(before) || before <= 0)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const sensorId = url.searchParams.get("sensorId") ?? undefined;

  return NextResponse.json({ audit: listAudit(getDb(), limit, before, sensorId) });
}
