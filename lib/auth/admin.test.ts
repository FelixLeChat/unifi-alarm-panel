import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "admin-token-for-tests";
const originalEnv = process.env.ADMIN_TOKEN;

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/admin/pins", { headers });
}

beforeEach(() => {
  // Fresh module graph per test so the rate-limit bucket it shares with
  // ./webhook and lib/services/rate-limit doesn't leak state across tests.
  vi.resetModules();
  process.env.ADMIN_TOKEN = TOKEN;
});

afterEach(() => {
  process.env.ADMIN_TOKEN = originalEnv;
});

describe("verifyAdminToken", () => {
  it("accepts the correct header", async () => {
    const { verifyAdminToken } = await import("./admin");
    expect(verifyAdminToken(req({ "x-admin-token": TOKEN }))).toBe(true);
  });

  it("rejects a wrong token", async () => {
    const { verifyAdminToken } = await import("./admin");
    expect(verifyAdminToken(req({ "x-admin-token": "wrong" }))).toBe(false);
  });

  it("rejects a missing token", async () => {
    const { verifyAdminToken } = await import("./admin");
    expect(verifyAdminToken(req())).toBe(false);
  });

  it("fails closed when no token is configured on the server", async () => {
    delete process.env.ADMIN_TOKEN;
    const { verifyAdminToken } = await import("./admin");
    expect(verifyAdminToken(req({ "x-admin-token": TOKEN }))).toBe(false);
  });

  it("locks out a source after repeated wrong tokens, even once it sends the right one", async () => {
    const { verifyAdminToken } = await import("./admin");
    const attacker = req({ "x-admin-token": "wrong", "x-forwarded-for": "10.0.0.9" });
    for (let i = 0; i < 5; i++) {
      verifyAdminToken(attacker);
    }
    expect(verifyAdminToken(req({ "x-admin-token": TOKEN, "x-forwarded-for": "10.0.0.9" }))).toBe(false);
  });

  it("does not lock out a different source", async () => {
    const { verifyAdminToken } = await import("./admin");
    const attacker = req({ "x-admin-token": "wrong", "x-forwarded-for": "10.0.0.9" });
    for (let i = 0; i < 5; i++) {
      verifyAdminToken(attacker);
    }
    expect(verifyAdminToken(req({ "x-admin-token": TOKEN, "x-forwarded-for": "10.0.0.1" }))).toBe(true);
  });
});
