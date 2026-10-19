export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getEngine } from "@/lib/engine";
import { getConnectivityStatus } from "@/lib/services/connectivity-watchdog";
import { getLastWebhookAgeSec } from "@/lib/services/webhook-intake";
import { getAppVersion } from "@/lib/version";

export async function GET() {
  try {
    const status = getEngine().getStatus();
    return NextResponse.json({
      ok: true,
      engine: "running",
      state: status.state,
      lastWebhookAgeSec: getLastWebhookAgeSec(),
      version: getAppVersion(),
      // Device names, MACs and battery levels stay behind /api/admin/connectivity; this endpoint is unauthenticated.
      connectivity: { ...getConnectivityStatus(), devices: undefined },
    });
  } catch {
    return NextResponse.json({ ok: false, engine: "error" }, { status: 503 });
  }
}
