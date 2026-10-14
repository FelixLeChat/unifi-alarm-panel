import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";
import { getConfigValue, setConfigValue } from "./config";
import { listAuditBetween } from "./audit";
import { auditRowsToCsv } from "./audit-export";

// Same directory the SQLite file lives in, not a separate env var to
// configure — one less thing to get wrong on a fresh box.
const ARCHIVE_DIR = path.join(path.dirname(process.env.DATABASE_PATH ?? "./data/alarm.db"), "audit-archive");

const CONFIG_KEY_LAST_ARCHIVED_DATE = "lastAuditArchiveDate";

function dateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDaysKey(key: string, days: number): string {
  const d = new Date(`${key}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return dateKey(d);
}

/**
 * Writes one CSV file per completed (never today, which is still in
 * progress) day of audit history that hasn't been archived yet —
 * "one log file per day" — without ever deleting from the live table. The
 * audit trail is deliberately append-only (see the DB trigger in
 * lib/db/schema.ts): this is a convenience export for offline
 * grep/spreadsheet use, not a retention/pruning mechanism. Progress is
 * tracked in config so a re-run (or the next scheduled tick) only picks up
 * where it left off instead of rescanning all history.
 */
export async function archiveCompletedAuditDays(db: Database.Database): Promise<void> {
  const todayKey = dateKey(new Date());
  let lastArchived = getConfigValue(db, CONFIG_KEY_LAST_ARCHIVED_DATE);

  if (!lastArchived) {
    const firstRow = db.prepare("SELECT MIN(ts) as ts FROM audit").get() as { ts: string | null };
    if (!firstRow.ts) return; // no audit history yet at all
    lastArchived = addDaysKey(firstRow.ts.slice(0, 10), -1);
  }

  let cursor = addDaysKey(lastArchived, 1);
  if (cursor >= todayKey) return; // already caught up

  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });

  while (cursor < todayKey) {
    const dayStart = `${cursor}T00:00:00.000Z`;
    const dayEnd = `${addDaysKey(cursor, 1)}T00:00:00.000Z`;
    const rows = listAuditBetween(db, dayStart, dayEnd);
    if (rows.length > 0) {
      const filePath = path.join(ARCHIVE_DIR, `audit-${cursor}.csv`);
      fs.writeFileSync(filePath, auditRowsToCsv(rows));
      logger.info({ date: cursor, count: rows.length, filePath }, "archived a day of audit history");
    }
    setConfigValue(db, CONFIG_KEY_LAST_ARCHIVED_DATE, cursor);
    cursor = addDaysKey(cursor, 1);
  }
}

// Runs every 6 hours — this only ever catches up whichever day(s) rolled
// over since the last tick, so there's no need for anything finer-grained
// than "at least once a day, with margin." Also runs once immediately on
// boot (see lib/scheduler.ts), so a deploy/restart doesn't leave a gap.
export const auditArchiveJob = { name: "audit-archive", intervalMs: 6 * 60 * 60 * 1000, run: () => archiveCompletedAuditDays(getDb()) };
