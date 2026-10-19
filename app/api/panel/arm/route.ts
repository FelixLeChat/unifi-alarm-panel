export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { readSmallJsonBody } from "@/lib/validation";
import { getEngine } from "@/lib/engine";

/**
 * Arming from the kiosk needs no PIN — only a "yes, arm" confirmation (see
 * app/panel/page.tsx). Disarming stays PIN-gated (/api/disarm); that's the
 * actual security boundary, not arming. See lib/engine/index.ts armWithoutPin().
 * Body is optional — an empty POST (existing behavior) means force=false.
 */
export async function POST(req: Request) {
  const body = await readSmallJsonBody(req);
  const force = (body as { force?: unknown } | null)?.force === true;

  const result = getEngine().armWithoutPin("Panel", force);
  if (result.reason === "sensors_open") {
    return NextResponse.json({ ok: false, reason: result.reason, openSensors: result.openSensors }, { status: 409 });
  }
  return NextResponse.json({ ok: result.ok });
}
