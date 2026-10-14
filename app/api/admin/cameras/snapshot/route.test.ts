import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSnapshot = vi.fn();
vi.mock("@/lib/services/protect-client", () => ({ getProtectClient: () => ({ getSnapshot }) }));

const ADMIN_TOKEN = "test-admin-token";

beforeEach(() => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  getSnapshot.mockReset();
});

afterEach(() => {
  vi.resetModules();
});

function adminReq(url: string): Request {
  return new Request(`http://localhost${url}`, { headers: { "x-admin-token": ADMIN_TOKEN } });
}

describe("admin camera snapshot route", () => {
  it("rejects requests without the admin token", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/admin/cameras/snapshot?cameraId=cam-1"));
    expect(res.status).toBe(401);
  });

  it("rejects a request with no cameraId", async () => {
    const { GET } = await import("./route");
    const res = await GET(adminReq("/api/admin/cameras/snapshot"));
    expect(res.status).toBe(400);
  });

  it("returns 404 when the Protect client has no snapshot for that camera", async () => {
    getSnapshot.mockResolvedValue(null);
    const { GET } = await import("./route");
    const res = await GET(adminReq("/api/admin/cameras/snapshot?cameraId=cam-1"));
    expect(res.status).toBe(404);
  });

  it("streams the snapshot bytes with the right content type", async () => {
    getSnapshot.mockResolvedValue({ buffer: Buffer.from([1, 2, 3]), contentType: "image/jpeg" });
    const { GET } = await import("./route");
    const res = await GET(adminReq("/api/admin/cameras/snapshot?cameraId=cam-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(Array.from(new Uint8Array(await res.arrayBuffer()))).toEqual([1, 2, 3]);
    expect(getSnapshot).toHaveBeenCalledWith("cam-1");
  });
});
