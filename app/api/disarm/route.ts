export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { clientKey } from "@/lib/auth/client-key";
import { getEngine } from "@/lib/engine";
import { pinBodySchema, readSmallJsonBody } from "@/lib/validation";

export async function POST(req: Request) {
  const body = await readSmallJsonBody(req);
  const parsed = pinBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const result = await getEngine().disarm(parsed.data.pin, clientKey(req));
  if (result.lockedOut) {
    return NextResponse.json({ ok: false }, { status: 429 });
  }
  return NextResponse.json({ ok: result.ok, remainingAttempts: result.remainingAttempts }, { status: result.ok ? 200 : 401 });
}
