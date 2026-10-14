export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/auth/admin";
import { checkConnectivityNow, getConnectivityStatus } from "@/lib/services/connectivity-watchdog";

/**
 * Admin-gated, unlike /api/health's read-only connectivity field — a refresh
 * makes a live Protect API snapshot call (when PROTECT_DEFAULT_CAMERA_ID is
 * set), which shouldn't be triggerable by anyone hitting the unauthenticated
 * health endpoint.
 */
export async function GET(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  // Normally relies on the 5-minute scheduled job (lib/services/connectivity-watchdog.ts)
  // and the 2-hour device-health poll (lib/services/protect-device-health.ts) —
  // this lets the admin force both on demand instead of waiting for the next tick.
  if (new URL(req.url).searchParams.get("refresh") === "true") {
    await checkConnectivityNow();
  }
  return NextResponse.json(getConnectivityStatus());
}
