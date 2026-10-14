import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { MIGRATIONS } from "./schema";

function tableExists(db: Database.Database, name: string): boolean {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
}

describe("schema migrations", () => {
  it("apply cleanly against a database that already has real rows, not just a fresh empty one", () => {
    // Every migration after the first runs, on a live box, against tables
    // that already hold real data. createDb() always applies every
    // migration to a brand-new empty database, so that's the only scenario
    // every other test exercises — a change that behaves differently
    // against a non-empty table (e.g. SQLite's ALTER TABLE ADD COLUMN
    // rejecting a non-constant default, which it allows against an empty
    // table) is invisible until it hits production. Seed a row after each
    // migration, before applying the next one, to catch that class of bug
    // here instead.
    const db = new Database(":memory:");
    let pinCount = 0;
    let sensorCount = 0;

    for (const migration of MIGRATIONS) {
      expect(() => db.exec(migration.sql)).not.toThrow();

      if (tableExists(db, "pins")) {
        db.prepare("INSERT INTO pins (label, hash) VALUES (?, ?)").run(`Pin ${++pinCount}`, "hash");
      }
      if (tableExists(db, "sensors")) {
        db.prepare("INSERT INTO sensors (unifi_id, name) VALUES (?, ?)").run(`sensor-${++sensorCount}`, "Sensor");
      }
    }

    expect(pinCount).toBeGreaterThan(0);
    expect(sensorCount).toBeGreaterThan(0);
  });
});
