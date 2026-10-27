import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { listAudit } from "@/lib/services/audit";
import { getSetting } from "@/lib/services/settings";
import { GET, PUT } from "./route";
import { POST as TEST } from "./test/route";

const ADMIN_TOKEN = "test-admin-token";
const originalKey = process.env.SECRETS_KEY;

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.SECRETS_KEY = Buffer.alloc(32, 3).toString("base64");
  closeDb();
});

afterEach(() => {
  closeDb();
  vi.unstubAllGlobals();
  if (originalKey === undefined) delete process.env.SECRETS_KEY;
  else process.env.SECRETS_KEY = originalKey;
});

function adminReq(method: string, body?: unknown, url = "/api/admin/settings"): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("admin settings route", () => {
  it("rejects requests without the admin token", async () => {
    expect((await GET(new Request("http://localhost/api/admin/settings"))).status).toBe(401);
    expect((await PUT(new Request("http://localhost/api/admin/settings", { method: "PUT", body: "{}" }))).status).toBe(
      401,
    );
    expect(
      (await TEST(new Request("http://localhost/api/admin/settings/test", { method: "POST", body: "{}" }))).status,
    ).toBe(401);
  });

  it("saves a group and never returns a secret's value, in the response or the audit log", async () => {
    const res = await PUT(
      adminReq("PUT", {
        group: "console",
        values: { protectApiBaseUrl: "https://192.168.1.1", protectApiKey: "very-secret-key" },
      }),
    );
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("very-secret-key");
    const body = JSON.parse(raw);
    expect(body.consoleConfigured).toBe(true);
    expect(body.groups.console.secrets.protectApiKey).toEqual({ set: true, readable: true });
    expect(getSetting("protectApiKey", getDb())).toBe("very-secret-key");

    expect(await (await GET(adminReq("GET"))).text()).not.toContain("very-secret-key");

    const audit = listAudit(getDb(), 10).find((row) => row.event === "settings_updated");
    expect(audit).toBeDefined();
    expect(JSON.stringify(audit)).not.toContain("very-secret-key");
    expect(JSON.stringify(audit)).toContain("protectApiKey");
  });

  it("returns 400 with the reason for an invalid value", async () => {
    const res = await PUT(adminReq("PUT", { group: "panel", values: { quietHoursStart: "25" } }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("quietHoursStart");
  });

  it("reports a skipped check when nothing is configured", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } })),
    );
    const res = await TEST(adminReq("POST", { target: "notifications" }, "/api/admin/settings/test"));
    const { results } = await res.json();
    expect(results).toEqual([expect.objectContaining({ status: "skipped" })]);
  });

  it("reports why a console check failed", async () => {
    await PUT(
      adminReq("PUT", { group: "console", values: { protectApiBaseUrl: "https://192.168.1.1", protectApiKey: "k" } }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        String(url).includes("/cameras") ? { ok: false, status: 401 } : { ok: true, status: 200 },
      ),
    );
    const res = await TEST(adminReq("POST", { target: "console" }, "/api/admin/settings/test"));
    const { results } = (await res.json()) as { results: { name: string; status: string; detail: string }[] };
    const api = results.find((r) => r.name === "Protect Integration API");
    expect(api).toEqual(expect.objectContaining({ status: "failed", detail: expect.stringContaining("API key") }));
    expect(results.find((r) => r.name.startsWith("SuperAdmin"))?.status).toBe("skipped");
    expect(results.find((r) => r.name.startsWith("go2rtc"))?.status).toBe("ok");
  });
});
