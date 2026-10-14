export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminToken } from "@/lib/auth/admin";
import { CHANNELS, type ChannelId } from "@/lib/services/notifiers";
import { checkConsole, checkNotifications } from "@/lib/services/settings-check";

const bodySchema = z.object({
  target: z.enum(["console", "notifications"]),
  /** With target "notifications": test only this channel. */
  channel: z.enum(CHANNELS.map((c) => c.id) as [ChannelId, ...ChannelId[]]).optional(),
});

/** Runs Settings > Test connection or Send test alert against the saved settings. */
export async function POST(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const parsed = bodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, error: 'expected { target: "console" | "notifications", channel?: id }' }, { status: 400 });
  }
  const results = parsed.data.target === "console" ? await checkConsole() : await checkNotifications(parsed.data.channel);
  return NextResponse.json({ results });
}
