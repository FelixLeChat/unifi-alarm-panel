export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminToken } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { recordAudit } from "@/lib/services/audit";
import { createPin, isPinTaken, listPins, revokePin, updatePin } from "@/lib/services/pins";
import { pinSchema } from "@/lib/validation";

const createPinSchema = z.object({
  label: z.string().trim().min(1).max(64),
  pin: pinSchema,
  isDuress: z.boolean().optional(),
});

const updatePinSchema = z
  .object({
    label: z.string().trim().min(1).max(64).optional(),
    pin: pinSchema.optional(),
    isDuress: z.boolean().optional(),
  })
  .refine((v) => v.label !== undefined || v.pin !== undefined || v.isDuress !== undefined, "Nothing to update");

export async function GET(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json({ pins: listPins(getDb()) });
}

export async function POST(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const parsed = createPinSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const db = getDb();
  // 409, not 400: the request is well-formed, the code just collides with a
  // PIN that already exists. Allowing it would silently shadow one of the two
  // (see isPinTaken) — worst of all for a duress code, which would then never
  // fire. The response deliberately doesn't say WHOSE PIN it collides with.
  if (await isPinTaken(db, parsed.data.pin)) {
    return NextResponse.json({ ok: false, error: "pin_taken" }, { status: 409 });
  }
  await createPin(db, parsed.data.label, parsed.data.pin, parsed.data.isDuress ?? false);
  recordAudit(db, "pin_created", { detail: { label: parsed.data.label } });
  return NextResponse.json({ ok: true }, { status: 201 });
}

export async function PATCH(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }
  const parsed = updatePinSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const db = getDb();
  if (parsed.data.pin !== undefined && (await isPinTaken(db, parsed.data.pin, id))) {
    return NextResponse.json({ ok: false, error: "pin_taken" }, { status: 409 });
  }
  await updatePin(db, id, parsed.data);
  recordAudit(db, "pin_updated", { detail: { id, fields: Object.keys(parsed.data) } });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const db = getDb();
  revokePin(db, id);
  recordAudit(db, "pin_revoked", { detail: { id } });
  return NextResponse.json({ ok: true });
}
