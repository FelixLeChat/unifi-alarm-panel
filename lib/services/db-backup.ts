import { mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import { getDb } from "@/lib/db";
import { logger } from "@/lib/logger";

// Same directory the SQLite file lives in, not a separate env var to
// configure — same reasoning as audit-archive.ts's ARCHIVE_DIR.
const BACKUP_DIR = path.join(path.dirname(process.env.DATABASE_PATH ?? "./data/alarm.db"), "backups");
const FILE_PREFIX = "alarm-";
const RETAIN_COUNT = 14;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function backupFileName(d: Date): string {
  const stamp = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
  return `${FILE_PREFIX}${stamp}.db`;
}

/**
 * Writes one full snapshot of the live SQLite file — the only datastore for
 * PINs, audit history, config, and sensors, with nothing else backing it up
 * (see the "Backups" section in README.md for the restore procedure).
 * db.backup() is better-sqlite3's native binding to SQLite's own online
 * backup API: safe against a database being written to concurrently (this
 * app's WAL journal mode included), no shelling out, no need to pause the
 * engine. Prunes to the RETAIN_COUNT most recent — filenames sort
 * chronologically, so that's just "keep the last N by name".
 */
export async function runDbBackup(db: Database.Database): Promise<string | null> {
  if (db.name === ":memory:") return null; // nothing to back up

  mkdirSync(BACKUP_DIR, { recursive: true });
  const fileName = backupFileName(new Date());
  const destPath = path.join(BACKUP_DIR, fileName);

  await db.backup(destPath);
  logger.info({ destPath }, "database backed up");

  pruneOldBackups();
  return destPath;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

export function pruneOldBackups(): void {
  const files = readdirSyncSafe(BACKUP_DIR)
    .filter((f) => f.startsWith(FILE_PREFIX) && f.endsWith(".db"))
    .sort(); // filenames are zero-padded and chronological, so lexicographic sort is chronological too

  const toDelete = files.slice(0, Math.max(0, files.length - RETAIN_COUNT));
  for (const f of toDelete) {
    try {
      unlinkSync(path.join(BACKUP_DIR, f));
    } catch (err) {
      logger.warn({ err, file: f }, "failed to prune an old database backup");
    }
  }
}

export const dbBackupJob = {
  name: "db-backup",
  intervalMs: 24 * 60 * 60 * 1000,
  run: async () => {
    await runDbBackup(getDb());
  },
};
