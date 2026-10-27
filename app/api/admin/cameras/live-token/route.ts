export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { issueStreamToken } from "@/lib/auth/stream-token";
import { verifyAdminToken } from "@/lib/auth/admin";
import { isSafeStreamName } from "@/lib/services/go2rtc-client";

/** Mints a short-lived token the admin UI passes to /api/admin/cameras/live — see lib/auth/stream-token.ts for why. */
export async function GET(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const cameraId = new URL(req.url).searchParams.get("cameraId");
  if (!cameraId || !isSafeStreamName(cameraId)) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  return NextResponse.json({ token: issueStreamToken(cameraId) });
}
