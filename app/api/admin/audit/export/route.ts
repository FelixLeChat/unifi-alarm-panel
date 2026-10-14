export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { verifyAdminToken } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { listAudit } from "@/lib/services/audit";
import { auditRowsToCsv } from "@/lib/services/audit-export";

const EXPORT_LIMIT = 200;

/**
 * The 200 most recent events as CSV, newest first — a quick everyday export
 * beyond what the paginated admin UI shows on screen, not the full history
 * (which keeps growing indefinitely — see lib/services/audit-archive.ts for
 * that; it writes one CSV per day to disk instead). Includes the raw detail
 * JSON, not just the humanized one-line description, since that's usually
 * the part that actually explains what happened.
 */
export async function GET(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  const filename = `audit-log-${new Date().toISOString().slice(0, 10)}.csv`;
  return new NextResponse(auditRowsToCsv(listAudit(getDb(), EXPORT_LIMIT)), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}
