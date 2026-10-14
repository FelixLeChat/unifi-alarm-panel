import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { recordAudit } from "@/lib/services/audit";
import { GET } from "./route";

const ADMIN_TOKEN = "test-admin-token";

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  closeDb();
});

afterEach(() => {
  closeDb();
});

function adminReq(): Request {
  return new Request("http://localhost/api/admin/audit/export", { headers: { "x-admin-token": ADMIN_TOKEN } });
}

describe("admin audit export route", () => {
  it("rejects requests without the admin token", async () => {
    const res = await GET(new Request("http://localhost/api/admin/audit/export"));
    expect(res.status).toBe(401);
  });

  it("returns a downloadable CSV with a header row and the full detail JSON", async () => {
    const db = getDb();
    recordAudit(db, "pin_created", { actorLabel: "Alex", detail: { label: "Front desk" } });

    const res = await GET(adminReq());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    expect(res.headers.get("content-disposition")).toContain("attachment");

    const text = await res.text();
    const lines = text.trim().split("\r\n");
    expect(lines[0]).toBe("id,timestamp,actor,event,category,description,detail_json");
    expect(lines[1]).toContain("pin_created");
    expect(lines[1]).toContain("Alex");
    // The raw detail JSON is embedded, quoted (it contains a comma-adjacent
    // colon/braces) — this is the whole point of the export.
    expect(lines[1]).toContain(JSON.stringify({ label: "Front desk" }).replace(/"/g, '""'));
  });

  it("caps the export at the 200 most recent events, newest first", async () => {
    const db = getDb();
    for (let i = 0; i < 250; i++) recordAudit(db, `event_${i}`);

    const res = await GET(adminReq());
    const text = await res.text();
    const lines = text.trim().split("\r\n");
    expect(lines).toHaveLength(201); // header + 200 rows
    expect(lines[1]).toContain("event_249"); // newest first
    expect(text).not.toContain("event_49"); // the oldest 50 got cut off
  });
});
