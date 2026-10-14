export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/auth/admin";
import { getEngine } from "@/lib/engine";

/**
 * Arming from the admin UI needs no PIN — the admin token itself is the
 * gate, same reasoning as the kiosk's /api/panel/arm. Disarming from the
 * admin UI is unchanged and still goes through /api/disarm with a PIN;
 * that's the actual security boundary. Logged with its own actorLabel
 * ("Admin") so the audit trail can tell this apart from the kiosk ("Panel")
 * or a PIN holder. See armWithoutPin() in lib/engine/index.ts.
 */
export async function POST(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const body = await req.json().catch(() => null);
  const force = (body as { force?: unknown } | null)?.force === true;

  const result = getEngine().armWithoutPin("Admin", force);
  if (result.reason === "sensors_open") {
    return NextResponse.json({ ok: false, reason: result.reason, openSensors: result.openSensors }, { status: 409 });
  }
  return NextResponse.json({ ok: result.ok });
}
