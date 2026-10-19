import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "@/lib/db";
import { createPin, isPinTaken, listPins, revokePin, updatePin, verifyPin } from "./pins";

let db: Database.Database;

beforeEach(() => {
  db = createDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("createPin / verifyPin", () => {
  it("stores an argon2id hash, never the PIN itself", async () => {
    await createPin(db, "Alice", "1234");
    const row = db.prepare("SELECT hash FROM pins").get() as { hash: string };
    expect(row.hash.startsWith("$argon2id$")).toBe(true);
    expect(row.hash).not.toContain("1234");
  });

  it("verifies the right PIN and rejects a wrong one without saying which row failed", async () => {
    await createPin(db, "Alice", "1234");
    await createPin(db, "Bob", "5678");
    expect(await verifyPin(db, "5678")).toEqual({ ok: true, label: "Bob", isDuress: false });
    expect(await verifyPin(db, "0000")).toEqual({ ok: false });
  });

  it("flags a duress PIN only in the verify result", async () => {
    await createPin(db, "Alice (duress)", "4321", true);
    expect(await verifyPin(db, "4321")).toEqual({ ok: true, label: "Alice (duress)", isDuress: true });
    expect(listPins(db)[0]).toMatchObject({ label: "Alice (duress)", isDuress: true, active: true });
  });

  it("skips a malformed hash instead of failing the whole check", async () => {
    db.prepare(
      "INSERT INTO pins (label, hash, updated_at) VALUES ('broken', 'not-a-hash', '2026-01-01T00:00:00Z')",
    ).run();
    await createPin(db, "Alice", "1234");
    expect(await verifyPin(db, "1234")).toMatchObject({ ok: true, label: "Alice" });
  });
});

describe("revokePin", () => {
  it("keeps the row but stops it from verifying", async () => {
    await createPin(db, "Alice", "1234");
    const { id } = listPins(db)[0];
    revokePin(db, id);
    expect(listPins(db)[0].active).toBe(false);
    expect(await verifyPin(db, "1234")).toEqual({ ok: false });
  });
});

describe("updatePin", () => {
  it("changes only the given fields and always bumps updated_at", async () => {
    await createPin(db, "Alice", "1234");
    const before = listPins(db)[0];
    db.prepare("UPDATE pins SET updated_at = '2000-01-01T00:00:00.000Z'").run();

    await updatePin(db, before.id, { label: "Alicia" });
    const after = listPins(db)[0];
    expect(after.label).toBe("Alicia");
    expect(after.isDuress).toBe(false);
    expect(after.updatedAt > "2000-01-01T00:00:00.000Z").toBe(true);
    expect(await verifyPin(db, "1234")).toMatchObject({ ok: true, label: "Alicia" });

    await updatePin(db, before.id, { pin: "9999", isDuress: true });
    expect(await verifyPin(db, "1234")).toEqual({ ok: false });
    expect(await verifyPin(db, "9999")).toEqual({ ok: true, label: "Alicia", isDuress: true });
  });
});

describe("isPinTaken", () => {
  it("sees active PINs only, and lets an edit keep its own code", async () => {
    await createPin(db, "Alice", "1234");
    await createPin(db, "Bob", "5678");
    const [alice, bob] = listPins(db);

    expect(await isPinTaken(db, "1234")).toBe(true);
    expect(await isPinTaken(db, "0000")).toBe(false);
    expect(await isPinTaken(db, "1234", alice.id)).toBe(false);
    expect(await isPinTaken(db, "1234", bob.id)).toBe(true);

    revokePin(db, alice.id);
    expect(await isPinTaken(db, "1234")).toBe(false);
  });
});
