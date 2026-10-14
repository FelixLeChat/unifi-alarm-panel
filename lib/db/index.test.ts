import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Migration } from "./schema";
import { createDb, migrate } from "./index";

describe("migrate", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "uap-db-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is idempotent — reopening an already-migrated database doesn't re-run migrations or lose data", () => {
    const dbPath = join(dir, "alarm.db");
    const db1 = createDb(dbPath);
    db1.prepare("INSERT INTO pins (label, hash, updated_at) VALUES (?, ?, ?)").run(
      "Existing",
      "hash",
      "2026-01-01T00:00:00.000Z",
    );
    db1.close();

    // A real restart re-runs createDb() against the same file. Re-applying
    // CREATE TABLE / already-applied ALTERs would throw on a schema that
    // already has them — this must skip everything already recorded and
    // leave prior data intact.
    const db2 = createDb(dbPath);
    const pins = db2.prepare("SELECT label FROM pins").all() as { label: string }[];
    expect(pins).toEqual([{ label: "Existing" }]);
    db2.close();
  });

  it("a failing migration is never marked applied, so a corrected version runs cleanly on the next boot", () => {
    // Mirrors the real incident: migration 2 runs against a table that
    // already has a row (from migration 1) and uses a non-constant DEFAULT,
    // which SQLite's ALTER TABLE ADD COLUMN rejects.
    const dbPath = join(dir, "alarm.db");
    const db = new Database(dbPath);

    const broken: Migration[] = [
      { id: 1, sql: "CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL); INSERT INTO widgets (label) VALUES ('existing');" },
      { id: 2, sql: "ALTER TABLE widgets ADD COLUMN note TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'));" },
    ];
    expect(() => migrate(db, broken)).toThrow(/non-constant default/);

    const appliedAfterFailure = (db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map(
      (r) => r.id,
    );
    expect(appliedAfterFailure).toEqual([1]); // the good migration is recorded, the broken one is not

    const fixed: Migration[] = [
      broken[0],
      { id: 2, sql: "ALTER TABLE widgets ADD COLUMN note TEXT; UPDATE widgets SET note = 'backfilled' WHERE note IS NULL;" },
    ];
    expect(() => migrate(db, fixed)).not.toThrow();

    const appliedAfterFix = (db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map(
      (r) => r.id,
    );
    expect(appliedAfterFix).toEqual([1, 2]);
    expect(db.prepare("SELECT note FROM widgets").get()).toEqual({ note: "backfilled" });

    db.close();
  });
});
