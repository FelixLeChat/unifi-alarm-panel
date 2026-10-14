import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ADMIN_TOKEN = "test-admin-token";

beforeEach(() => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
});

afterEach(() => {
  delete globalThis.__uapStreamTokens;
});

function adminReq(url: string): Request {
  return new Request(`http://localhost${url}`, { headers: { "x-admin-token": ADMIN_TOKEN } });
}

describe("admin camera live-token route", () => {
  it("rejects requests without the admin token", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/admin/cameras/live-token?cameraId=cam-1"));
    expect(res.status).toBe(401);
  });

  it("rejects a request with no cameraId", async () => {
    const { GET } = await import("./route");
    const res = await GET(adminReq("/api/admin/cameras/live-token"));
    expect(res.status).toBe(400);
  });

  it("issues a token that the live route accepts for the same cameraId", async () => {
    const { GET } = await import("./route");
    const res = await GET(adminReq("/api/admin/cameras/live-token?cameraId=cam-1"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token: string };
    expect(body.token).toBeTruthy();

    const { consumeStreamToken } = await import("@/lib/auth/stream-token");
    expect(consumeStreamToken(body.token, "cam-1")).toBe(true);
  });
});
