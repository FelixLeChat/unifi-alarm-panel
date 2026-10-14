import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db";
import { GET } from "./route";

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  closeDb();
  delete globalThis.__uapEngine;
});

afterEach(() => {
  closeDb();
  delete globalThis.__uapEngine;
});

describe("status route", () => {
  it("reports DISARMED with no triggeredBy, plus version and uptime", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      state: string;
      triggeredBy: unknown;
      version: string;
      uptimeSec: number;
    };
    expect(body.state).toBe("DISARMED");
    expect(body.triggeredBy).toBeNull();
    expect(typeof body.version).toBe("string");
    expect(body.uptimeSec).toBeGreaterThanOrEqual(0);
  });
});
