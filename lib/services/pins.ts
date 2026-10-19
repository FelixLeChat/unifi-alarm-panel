import argon2 from "argon2";
import type Database from "better-sqlite3";

export interface PinSummary {
  id: number;
  label: string;
  isDuress: boolean;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PinUpdate {
  label?: string;
  pin?: string;
  isDuress?: boolean;
}

export interface VerifyResult {
  ok: boolean;
  label?: string;
  isDuress?: boolean;
}

export async function createPin(db: Database.Database, label: string, pin: string, isDuress = false): Promise<void> {
  const hash = await argon2.hash(pin, { type: argon2.argon2id });
  db.prepare(
    "INSERT INTO pins (label, hash, is_duress, updated_at) VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))",
  ).run(label, hash, isDuress ? 1 : 0);
}

export function listPins(db: Database.Database): PinSummary[] {
  const rows = db
    .prepare("SELECT id, label, is_duress, active, created_at, updated_at FROM pins ORDER BY id")
    .all() as {
    id: number;
    label: string;
    is_duress: number;
    active: number;
    created_at: string;
    updated_at: string;
  }[];
  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    isDuress: !!row.is_duress,
    active: !!row.active,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

export function revokePin(db: Database.Database, id: number): void {
  db.prepare("UPDATE pins SET active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
}

/** Edits an existing PIN's label, code, and/or duress flag. Always bumps updated_at, even if nothing else changed. */
export async function updatePin(db: Database.Database, id: number, update: PinUpdate): Promise<void> {
  const sets = ["updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')"];
  const params: unknown[] = [];

  if (update.label !== undefined) {
    sets.push("label = ?");
    params.push(update.label);
  }
  if (update.pin !== undefined) {
    sets.push("hash = ?");
    params.push(await argon2.hash(update.pin, { type: argon2.argon2id }));
  }
  if (update.isDuress !== undefined) {
    sets.push("is_duress = ?");
    params.push(update.isDuress ? 1 : 0);
  }

  params.push(id);
  db.prepare(`UPDATE pins SET ${sets.join(", ")} WHERE id = ?`).run(...params);
}

/**
 * Whether `pin` already matches an active PIN. verifyPin below returns the
 * FIRST matching row, so a duplicate code is silently shadowed by whichever
 * was created first — and a shadowed duress PIN is catastrophic: it disarms
 * as the other person, attributes the audit entry to them, and never fires
 * the DURESS alert. Reproduced before this check existed.
 *
 * Hashes are salted, so there's no index to check against — this has to try
 * the candidate against each active hash, same as verifyPin. Fine at this
 * app's scale (one office's worth of PINs, checked only on create/edit).
 *
 * `excludeId` lets an edit that leaves the code unchanged pass its own row.
 */
export async function isPinTaken(db: Database.Database, pin: string, excludeId?: number): Promise<boolean> {
  const rows = db.prepare("SELECT id, hash FROM pins WHERE active = 1").all() as { id: number; hash: string }[];
  for (const row of rows) {
    if (row.id === excludeId) continue;
    try {
      if (await argon2.verify(row.hash, pin)) return true;
    } catch {
      // Malformed hash on this row shouldn't block checking the rest.
    }
  }
  return false;
}

/**
 * A PIN doesn't identify who entered it, so the only way to check one is to
 * try it against every active hash. Never reveal which one matched.
 */
export async function verifyPin(db: Database.Database, pin: string): Promise<VerifyResult> {
  const rows = db.prepare("SELECT label, hash, is_duress FROM pins WHERE active = 1").all() as {
    label: string;
    hash: string;
    is_duress: number;
  }[];

  for (const row of rows) {
    try {
      if (await argon2.verify(row.hash, pin)) {
        return { ok: true, label: row.label, isDuress: !!row.is_duress };
      }
    } catch {
      // Malformed hash on this row shouldn't block checking the rest.
    }
  }
  return { ok: false };
}
