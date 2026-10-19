import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db";
import { getConfigValue } from "./config";

let dir: string;
let dbPath: string;
let archiveDir: string;
let db: Database.Database;
const originalDatabasePath = process.env.DATABASE_PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "uap-audit-archive-test-"));
  dbPath = join(dir, "alarm.db");
  archiveDir = join(dir, "audit-archive");
  process.env.DATABASE_PATH = dbPath;
  db = createDb(dbPath);
  // ARCHIVE_DIR is computed once at module load from DATABASE_PATH — force
  // a fresh import per test so it picks up this test's own temp dir.
  vi.resetModules();
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
  vi.useRealTimers();
  if (originalDatabasePath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalDatabasePath;
});

function insertAuditAt(ts: string, event: string): void {
  db.prepare("INSERT INTO audit (ts, event) VALUES (?, ?)").run(ts, event);
}

describe("archiveCompletedAuditDays", () => {
  it("writes one CSV per completed day, never for today", async () => {
    insertAuditAt("2026-01-01T10:00:00.000Z", "armed");
    insertAuditAt("2026-01-01T11:00:00.000Z", "disarmed");
    insertAuditAt("2026-01-02T09:00:00.000Z", "armed");
    insertAuditAt("2026-01-03T08:00:00.000Z", "armed"); // "today" — must not be archived yet

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-03T12:00:00.000Z"));

    const { archiveCompletedAuditDays } = await import("./audit-archive");
    await archiveCompletedAuditDays(db);

    expect(readdirSync(archiveDir).sort()).toEqual(["audit-2026-01-01.csv", "audit-2026-01-02.csv"]);

    const day1 = readFileSync(join(archiveDir, "audit-2026-01-01.csv"), "utf8");
    expect(day1.trim().split("\r\n")).toHaveLength(3); // header + 2 rows
    const day2 = readFileSync(join(archiveDir, "audit-2026-01-02.csv"), "utf8");
    expect(day2.trim().split("\r\n")).toHaveLength(2); // header + 1 row
  });

  it("never removes rows from the live table — archiving is additive, not pruning", async () => {
    insertAuditAt("2026-01-01T10:00:00.000Z", "armed");
    insertAuditAt("2026-01-01T11:00:00.000Z", "disarmed");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T12:00:00.000Z"));

    const { archiveCompletedAuditDays } = await import("./audit-archive");
    await archiveCompletedAuditDays(db);

    const { c } = db.prepare("SELECT COUNT(*) as c FROM audit").get() as { c: number };
    expect(c).toBe(2);
  });

  it("skips a day with zero events without writing an empty file, but still advances past it", async () => {
    insertAuditAt("2026-01-01T10:00:00.000Z", "armed");
    // Nothing on 2026-01-02.
    insertAuditAt("2026-01-03T10:00:00.000Z", "armed");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-04T00:00:01.000Z"));

    const { archiveCompletedAuditDays } = await import("./audit-archive");
    await archiveCompletedAuditDays(db);

    expect(readdirSync(archiveDir).sort()).toEqual(["audit-2026-01-01.csv", "audit-2026-01-03.csv"]);
    expect(getConfigValue(db, "lastAuditArchiveDate")).toBe("2026-01-03");
  });

  it("is idempotent — re-running doesn't rewrite or duplicate already-archived days", async () => {
    insertAuditAt("2026-01-01T10:00:00.000Z", "armed");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T12:00:00.000Z"));

    const { archiveCompletedAuditDays } = await import("./audit-archive");
    await archiveCompletedAuditDays(db);
    const firstRun = readFileSync(join(archiveDir, "audit-2026-01-01.csv"), "utf8");

    await archiveCompletedAuditDays(db);
    expect(readdirSync(archiveDir)).toEqual(["audit-2026-01-01.csv"]);
    expect(readFileSync(join(archiveDir, "audit-2026-01-01.csv"), "utf8")).toBe(firstRun);
  });

  it("picks up a new day on the next tick instead of rescanning history", async () => {
    insertAuditAt("2026-01-01T10:00:00.000Z", "armed");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-02T12:00:00.000Z"));
    const { archiveCompletedAuditDays } = await import("./audit-archive");
    await archiveCompletedAuditDays(db);

    insertAuditAt("2026-01-02T09:00:00.000Z", "armed");
    vi.setSystemTime(new Date("2026-01-03T12:00:00.000Z"));
    await archiveCompletedAuditDays(db);

    expect(readdirSync(archiveDir).sort()).toEqual(["audit-2026-01-01.csv", "audit-2026-01-02.csv"]);
  });

  it("does nothing when the audit table is empty", async () => {
    const { archiveCompletedAuditDays } = await import("./audit-archive");
    await expect(archiveCompletedAuditDays(db)).resolves.not.toThrow();
    expect(() => readdirSync(archiveDir)).toThrow(); // never even created the directory
  });
});
