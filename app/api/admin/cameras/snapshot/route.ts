export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/auth/admin";
import { getProtectClient } from "@/lib/services/protect-client";

/**
 * Proxies a Protect snapshot for the admin UI's camera preview — the
 * browser can't send X-API-KEY to the console directly (LAN-only, self-signed
 * cert, and the key would otherwise ship to the client), so this fetches it
 * server-side with the same client the alarm engine uses.
 */
export async function GET(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const cameraId = new URL(req.url).searchParams.get("cameraId");
  if (!cameraId) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const snapshot = await getProtectClient().getSnapshot(cameraId);
  if (!snapshot) {
    return NextResponse.json({ ok: false }, { status: 404 });
  }

  return new NextResponse(new Blob([Uint8Array.from(snapshot.buffer)], { type: snapshot.contentType }), {
    headers: { "cache-control": "no-store" },
  });
}
