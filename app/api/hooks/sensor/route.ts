export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { verifyWebhookSecret } from "@/lib/auth/webhook";
import { clientKey } from "@/lib/auth/client-key";
import { getDb } from "@/lib/db";
import { getEngine } from "@/lib/engine";
import { recordAudit } from "@/lib/services/audit";
import { handleSensorWebhook } from "@/lib/services/sensor-webhook";

export async function POST(req: Request) {
  const url = new URL(req.url);
  if (!verifyWebhookSecret(req, url)) {
    // Logged (lib/auth/webhook.ts) and recorded here too — a wrong/missing
    // shared secret is exactly the kind of misconfiguration that otherwise
    // leaves "no sensors are showing up" undiagnosable from the admin UI.
    recordAudit(getDb(), "webhook_rejected", { detail: { source: clientKey(req) } });
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const rawBody = await req.text();
  const result = handleSensorWebhook(getDb(), getEngine(), rawBody);
  return NextResponse.json(result.body, { status: result.status });
}
