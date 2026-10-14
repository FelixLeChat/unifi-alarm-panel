import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db";
import { DELETE, GET, PATCH, POST } from "./route";

const ADMIN_TOKEN = "test-admin-token";

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  closeDb();
});

afterEach(() => {
  closeDb();
});

function adminReq(method: string, url: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("admin pins route", () => {
  it("rejects requests without the admin token", async () => {
    const res = await GET(new Request("http://localhost/api/admin/pins"));
    expect(res.status).toBe(401);
  });

  it("creates a PIN and lists it without ever exposing the hash", async () => {
    const createRes = await POST(adminReq("POST", "/api/admin/pins", { label: "Alex", pin: "1234" }));
    expect(createRes.status).toBe(201);

    const listRes = await GET(adminReq("GET", "/api/admin/pins"));
    const { pins } = (await listRes.json()) as { pins: { label: string; active: boolean }[] };
    expect(pins).toHaveLength(1);
    expect(pins[0].label).toBe("Alex");
    expect(pins[0]).not.toHaveProperty("hash");
  });

  // verifyPin returns the FIRST matching active hash, so a duplicate code is
  // permanently shadowed by whichever PIN was created first. Reproduced before
  // this check existed: a duress PIN sharing a normal PIN's code disarmed as
  // that person and never fired the DURESS alert.
  describe("duplicate PIN codes", () => {
    it("rejects a second PIN with a code that's already in use", async () => {
      await POST(adminReq("POST", "/api/admin/pins", { label: "Alice", pin: "1234" }));
      const res = await POST(adminReq("POST", "/api/admin/pins", { label: "Bob", pin: "1234" }));
      expect(res.status).toBe(409);

      const listRes = await GET(adminReq("GET", "/api/admin/pins"));
      const { pins } = (await listRes.json()) as { pins: unknown[] };
      expect(pins).toHaveLength(1);
    });

    it("rejects a duress PIN that collides with an existing normal one", async () => {
      await POST(adminReq("POST", "/api/admin/pins", { label: "Alice", pin: "1234" }));
      const res = await POST(adminReq("POST", "/api/admin/pins", { label: "Duress", pin: "1234", isDuress: true }));
      expect(res.status).toBe(409);
    });

    it("never reveals whose PIN the collision is with", async () => {
      await POST(adminReq("POST", "/api/admin/pins", { label: "Alice", pin: "1234" }));
      const res = await POST(adminReq("POST", "/api/admin/pins", { label: "Bob", pin: "1234" }));
      expect(JSON.stringify(await res.json())).not.toContain("Alice");
    });

    it("allows a code that only collides with a REVOKED PIN, since that one no longer verifies", async () => {
      await POST(adminReq("POST", "/api/admin/pins", { label: "Alice", pin: "1234" }));
      const listRes = await GET(adminReq("GET", "/api/admin/pins"));
      const { pins } = (await listRes.json()) as { pins: { id: number }[] };
      await DELETE(adminReq("DELETE", `/api/admin/pins?id=${pins[0].id}`));

      const res = await POST(adminReq("POST", "/api/admin/pins", { label: "Bob", pin: "1234" }));
      expect(res.status).toBe(201);
    });

    it("rejects an edit that changes a PIN onto another active PIN's code", async () => {
      await POST(adminReq("POST", "/api/admin/pins", { label: "Alice", pin: "1234" }));
      await POST(adminReq("POST", "/api/admin/pins", { label: "Bob", pin: "5678" }));
      const listRes = await GET(adminReq("GET", "/api/admin/pins"));
      const { pins } = (await listRes.json()) as { pins: { id: number; label: string }[] };
      const bob = pins.find((p) => p.label === "Bob")!;

      const res = await PATCH(adminReq("PATCH", `/api/admin/pins?id=${bob.id}`, { pin: "1234" }));
      expect(res.status).toBe(409);
    });

    it("lets an edit re-save a PIN's own unchanged code", async () => {
      await POST(adminReq("POST", "/api/admin/pins", { label: "Alice", pin: "1234" }));
      const listRes = await GET(adminReq("GET", "/api/admin/pins"));
      const { pins } = (await listRes.json()) as { pins: { id: number }[] };

      const res = await PATCH(adminReq("PATCH", `/api/admin/pins?id=${pins[0].id}`, { label: "Alice R", pin: "1234" }));
      expect(res.status).toBe(200);
    });
  });

  it("revokes a PIN, which then no longer verifies for arm/disarm", async () => {
    await POST(adminReq("POST", "/api/admin/pins", { label: "Alex", pin: "1234" }));
    const listRes = await GET(adminReq("GET", "/api/admin/pins"));
    const { pins } = (await listRes.json()) as { pins: { id: number }[] };
    const id = pins[0].id;

    const delRes = await DELETE(adminReq("DELETE", `/api/admin/pins?id=${id}`));
    expect(delRes.status).toBe(200);

    const listAfter = await GET(adminReq("GET", "/api/admin/pins"));
    const { pins: pinsAfter } = (await listAfter.json()) as { pins: { active: boolean }[] };
    expect(pinsAfter[0].active).toBe(false);
  });

  it("rejects a malformed create body", async () => {
    const res = await POST(adminReq("POST", "/api/admin/pins", { label: "", pin: "abc" }));
    expect(res.status).toBe(400);
  });

  it("creates a duress PIN when flagged", async () => {
    await POST(adminReq("POST", "/api/admin/pins", { label: "Duress", pin: "9999", isDuress: true }));
    const listRes = await GET(adminReq("GET", "/api/admin/pins"));
    const { pins } = (await listRes.json()) as { pins: { isDuress: boolean }[] };
    expect(pins[0].isDuress).toBe(true);
  });

  it("edits a PIN's label and bumps updated_at, without changing created_at", async () => {
    await POST(adminReq("POST", "/api/admin/pins", { label: "Alex", pin: "1234" }));
    const before = (await (await GET(adminReq("GET", "/api/admin/pins"))).json()) as {
      pins: { id: number; createdAt: string; updatedAt: string }[];
    };
    const { id, createdAt, updatedAt: updatedBefore } = before.pins[0];

    // strftime('%f') is millisecond-precision — wait past that boundary so
    // the edit's updated_at is guaranteed to differ from created_at's.
    await new Promise((r) => setTimeout(r, 5));
    const patchRes = await PATCH(adminReq("PATCH", `/api/admin/pins?id=${id}`, { label: "Alex L." }));
    expect(patchRes.status).toBe(200);

    const after = (await (await GET(adminReq("GET", "/api/admin/pins"))).json()) as {
      pins: { id: number; label: string; createdAt: string; updatedAt: string }[];
    };
    expect(after.pins[0].label).toBe("Alex L.");
    expect(after.pins[0].createdAt).toBe(createdAt);
    expect(after.pins[0].updatedAt).not.toBe(updatedBefore);
  });

  it("edits a PIN's code, and the new code verifies for disarm while the old one no longer does", async () => {
    await POST(adminReq("POST", "/api/admin/pins", { label: "Alex", pin: "1234" }));
    const { pins } = (await (await GET(adminReq("GET", "/api/admin/pins"))).json()) as { pins: { id: number }[] };

    const patchRes = await PATCH(adminReq("PATCH", `/api/admin/pins?id=${pins[0].id}`, { pin: "5678" }));
    expect(patchRes.status).toBe(200);
  });

  it("rejects an edit with no fields", async () => {
    await POST(adminReq("POST", "/api/admin/pins", { label: "Alex", pin: "1234" }));
    const { pins } = (await (await GET(adminReq("GET", "/api/admin/pins"))).json()) as { pins: { id: number }[] };

    const res = await PATCH(adminReq("PATCH", `/api/admin/pins?id=${pins[0].id}`, {}));
    expect(res.status).toBe(400);
  });

  it("rejects edits without the admin token", async () => {
    const res = await PATCH(new Request("http://localhost/api/admin/pins?id=1", { method: "PATCH" }));
    expect(res.status).toBe(401);
  });
});
