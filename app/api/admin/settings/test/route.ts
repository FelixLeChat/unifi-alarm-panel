export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminToken } from "@/lib/auth/admin";
import { checkConsole, checkNotifications } from "@/lib/services/settings-check";

const bodySchema = z.object({ target: z.enum(["console", "notifications"]) });

/** Runs Settings > Test connection or Send test alert against the saved settings. */
export async function POST(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'expected { target: "console" | "notifications" }' }, { status: 400 });
  }
  const results = parsed.data.target === "console" ? await checkConsole() : await checkNotifications();
  return NextResponse.json({ results });
}
