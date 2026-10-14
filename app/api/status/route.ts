export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine";
import { getAppVersion } from "@/lib/version";

export async function GET() {
  return NextResponse.json({ ...getEngine().getStatus(), version: getAppVersion(), uptimeSec: Math.floor(process.uptime()) });
}
