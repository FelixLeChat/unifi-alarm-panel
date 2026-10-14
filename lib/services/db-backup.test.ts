import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db";
import { upsertSensor } from "./sensors";

let dir: string;
let dbPath: string;
let backupDir: string;
let db: Database.Database;
const originalDatabasePath = process.env.DATABASE_PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uap-db-backup-test-"));
  dbPath = join(dir, "alarm.db");
  backupDir = join(dir, "backups");
  process.env.DATABASE_PATH = dbPath;
  db = createDb(dbPath);
  // BACKUP_DIR is computed once at module load from DATABASE_PATH — force a
  // fresh import per test so it picks up this test's own temp dir, same as
  // audit-archive.test.ts does for ARCHIVE_DIR.
  vi.resetModules();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

describe("runDbBackup", () => {
  it("writes a valid, openable SQLite snapshot with the same data", async () => {
    upsertSensor(db, "front-door", "Front Door", "instant");
    const { runDbBackup } = await import("./db-backup");

    const destPath = await runDbBackup(db);

    expect(destPath).toBeTruthy();
    expect(existsSync(destPath!)).toBe(true);
    const backup = new Database(destPath!, { readonly: true });
    const rows = backup.prepare("SELECT unifi_id FROM sensors").all() as { unifi_id: string }[];
    expect(rows).toEqual([{ unifi_id: "front-door" }]);
    backup.close();
  });

  it("does nothing for an in-memory database", async () => {
    const memDb = new Database(":memory:");
    const { runDbBackup } = await import("./db-backup");

    const destPath = await runDbBackup(memDb);

    expect(destPath).toBeNull();
    memDb.close();
  });

  it("keeps only the most recent RETAIN_COUNT (14) backups, oldest by filename pruned first", async () => {
    mkdirSync(backupDir, { recursive: true });
    for (let i = 0; i < 16; i++) {
      writeFileSync(join(backupDir, `alarm-2026-01-01-${String(i).padStart(4, "0")}.db`), "");
    }
    const { pruneOldBackups } = await import("./db-backup");

    pruneOldBackups();

    const files = readdirSync(backupDir).sort();
    expect(files).toHaveLength(14);
    expect(files[0]).toBe("alarm-2026-01-01-0002.db"); // the two oldest (0000, 0001) got pruned
    expect(files[13]).toBe("alarm-2026-01-01-0015.db");
  });
});
