export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { clientKey } from "@/lib/auth/client-key";
import { getEngine } from "@/lib/engine";
import { armBodySchema, readSmallJsonBody } from "@/lib/validation";

export async function POST(req: Request) {
  const body = await readSmallJsonBody(req);
  const parsed = armBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const result = await getEngine().arm(parsed.data.pin, clientKey(req), parsed.data.force ?? false);
  if (result.lockedOut) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }
  if (result.reason === "sensors_open") {
    return NextResponse.json({ ok: false, reason: result.reason, openSensors: result.openSensors }, { status: 409 });
  }
  return NextResponse.json({ ok: result.ok }, { status: result.ok ? 200 : 401 });
}
