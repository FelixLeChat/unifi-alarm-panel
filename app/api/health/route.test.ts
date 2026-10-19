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

describe("health route", () => {
  it("reports the engine and connectivity, without the device inventory (that is admin-only)", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; engine: string; connectivity: Record<string, unknown> };
    expect(body.ok).toBe(true);
    expect(body.engine).toBe("running");
    expect(body.connectivity).toBeDefined();
    expect("devices" in body.connectivity).toBe(false);
  });
});
