export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminToken } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { recordAudit } from "@/lib/services/audit";
import { secretsKeyStatus } from "@/lib/services/secrets";
import { describeSettings, isConsoleConfigured, saveSettings, SETTINGS_GROUPS } from "@/lib/services/settings";

// Secret values never leave the server: describeSettings() only says whether each one is set.
function snapshot() {
  const db = getDb();
  return {
    secretsKey: secretsKeyStatus(),
    consoleConfigured: isConsoleConfigured(db),
    groups: Object.fromEntries(SETTINGS_GROUPS.map((group) => [group, describeSettings(group, db)])),
  };
}

export async function GET(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  return NextResponse.json(snapshot());
}

const putSchema = z.object({
  group: z.enum(SETTINGS_GROUPS),
  values: z.record(z.string(), z.string().nullable()),
});

export async function PUT(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const parsed = putSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: "expected { group, values }" }, { status: 400 });
  }

  const db = getDb();
  const result = saveSettings(parsed.data.group, parsed.data.values, db);
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
  }
  if (result.changed.length > 0) {
    // Field names only: some of these are credentials.
    recordAudit(db, "settings_updated", { detail: { group: parsed.data.group, keys: result.changed } });
  }
  return NextResponse.json(snapshot());
}
