import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "@/lib/db";
import { getDelays, getExternalArmSyncDelaySec, MAX_DELAY_SEC, setConfigValue } from "./config";

let db: Database.Database;

beforeEach(() => {
  db = createDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("getDelays", () => {
  it("reads configured values", () => {
    setConfigValue(db, "exitDelaySec", "45");
    setConfigValue(db, "entryDelaySec", "20");
    expect(getDelays(db)).toEqual({ exitDelaySec: 45, entryDelaySec: 20 });
  });

  // Both of these reach setTimeout as NaN or a past-32-bit value, where Node
  // clamps the delay to ~1ms. Reproduced before the guard existed: a bad
  // exitDelaySec armed the system instantly with no time to leave, and a bad
  // entryDelaySec alarmed the instant a door opened, with no time to disarm.
  it("falls back to the default for a non-numeric value rather than passing NaN to setTimeout", () => {
    setConfigValue(db, "exitDelaySec", "abc");
    expect(getDelays(db).exitDelaySec).toBe(30);
  });

  // Number("") is 0, so without this a cleared field would mean "alarm the
  // instant a door opens" rather than "use the configured delay".
  it("treats a blank value as unset, not as zero", () => {
    setConfigValue(db, "entryDelaySec", "");
    setConfigValue(db, "exitDelaySec", "   ");
    expect(getDelays(db)).toEqual({ exitDelaySec: 30, entryDelaySec: 30 });
  });

  it("falls back to the default for a negative value", () => {
    setConfigValue(db, "exitDelaySec", "-5");
    expect(getDelays(db).exitDelaySec).toBe(30);
  });

  it("clamps an absurd value well below setTimeout's 32-bit ceiling", () => {
    setConfigValue(db, "exitDelaySec", "3000000");
    expect(getDelays(db).exitDelaySec).toBe(MAX_DELAY_SEC);
  });

  it("allows zero, which is a legitimate 'no delay' choice", () => {
    setConfigValue(db, "exitDelaySec", "0");
    expect(getDelays(db).exitDelaySec).toBe(0);
  });
});

describe("getExternalArmSyncDelaySec", () => {
  it("defaults to 5s when unset", () => {
    expect(getExternalArmSyncDelaySec(db)).toBe(5);
  });

  it("is guarded the same way as the other delays", () => {
    setConfigValue(db, "externalArmSyncDelaySec", "not-a-number");
    expect(getExternalArmSyncDelaySec(db)).toBe(5);
    setConfigValue(db, "externalArmSyncDelaySec", "99999999");
    expect(getExternalArmSyncDelaySec(db)).toBe(MAX_DELAY_SEC);
  });
});
