import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { seedDefaultConfig } from "@/lib/services/config";
import { seedSettingsFromEnv } from "@/lib/services/settings";
import { MIGRATIONS, type Migration } from "./schema";

export function createDb(dbPath: string): Database.Database {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  seedDefaultConfig(db);
  seedSettingsFromEnv(db);
  return db;
}

// Exported (with `migrations` overridable) so tests can exercise the actual
// apply/record/retry mechanism — not just individual migrations' SQL — with
// a throwaway migration list instead of the real one.
export function migrate(db: Database.Database, migrations: Migration[] = MIGRATIONS): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    )`,
  );
  const applied = new Set(
    (db.prepare("SELECT id FROM schema_migrations").all() as { id: number }[]).map((r) => r.id),
  );
  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    const run = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(migration.id);
    });
    run();
  }
}

// Next/Turbopack compiles each route handler and page into its own bundle;
// a plain module-scoped `let` gives each bundle its own copy instead of one
// shared instance. `globalThis` is the one thing actually shared by every
// bundle in the process, so the singleton lives there instead.
declare global {
  var __uapDb: Database.Database | undefined;
}

export function getDb(): Database.Database {
  if (!globalThis.__uapDb) {
    globalThis.__uapDb = createDb(process.env.DATABASE_PATH ?? "./data/alarm.db");
  }
  return globalThis.__uapDb;
}

export function closeDb(): void {
  globalThis.__uapDb?.close();
  globalThis.__uapDb = undefined;
}
