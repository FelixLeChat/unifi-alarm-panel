export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { consumeStreamToken } from "@/lib/auth/stream-token";
import { go2rtcMjpegUrl } from "@/lib/services/go2rtc-client";
import { logger } from "@/lib/logger";

/**
 * Proxies go2rtc's MJPEG output for the admin UI's <img> tag — go2rtc is
 * bound to localhost only (see deploy/go2rtc.yaml), and a plain <img> can't
 * carry the X-Admin-Token header, so this checks a short-lived stream token
 * (see lib/auth/stream-token.ts) instead of verifyAdminToken. The response
 * is a long-lived multipart/x-mixed-replace connection; piping the upstream
 * body straight through (rather than buffering) is what makes it "live".
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const cameraId = url.searchParams.get("cameraId");
  const token = url.searchParams.get("token");
  if (!cameraId || !token || !consumeStreamToken(token, cameraId)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  try {
    const upstream = await fetch(go2rtcMjpegUrl(cameraId), { signal: req.signal });
    if (!upstream.ok || !upstream.body) {
      return NextResponse.json({ ok: false }, { status: 502 });
    }
    return new NextResponse(upstream.body, {
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "multipart/x-mixed-replace",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    logger.warn({ err, cameraId }, "go2rtc live stream proxy threw");
    return NextResponse.json({ ok: false }, { status: 502 });
  }
}
