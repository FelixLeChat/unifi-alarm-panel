import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { issueStreamToken } from "@/lib/auth/stream-token";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  delete globalThis.__uapStreamTokens;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("admin camera live route", () => {
  it("rejects a request with no token", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/admin/cameras/live?cameraId=cam-1"));
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a token issued for a different camera", async () => {
    const token = issueStreamToken("cam-2");
    const { GET } = await import("./route");
    const res = await GET(new Request(`http://localhost/api/admin/cameras/live?cameraId=cam-1&token=${token}`));
    expect(res.status).toBe(401);
  });

  it("proxies go2rtc's MJPEG response body and content-type on a valid token", async () => {
    const token = issueStreamToken("cam-1");
    fetchMock.mockResolvedValue(
      new Response("frame-bytes", {
        status: 200,
        headers: { "content-type": "multipart/x-mixed-replace; boundary=ffserver" },
      }),
    );
    const { GET } = await import("./route");
    const res = await GET(new Request(`http://localhost/api/admin/cameras/live?cameraId=cam-1&token=${token}`));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("multipart/x-mixed-replace; boundary=ffserver");
    expect(await res.text()).toBe("frame-bytes");
    expect(fetchMock.mock.calls[0][0]).toContain("src=cam-1");
  });

  it("returns 502 when go2rtc responds with a non-2xx status", async () => {
    const token = issueStreamToken("cam-1");
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }));
    const { GET } = await import("./route");
    const res = await GET(new Request(`http://localhost/api/admin/cameras/live?cameraId=cam-1&token=${token}`));
    expect(res.status).toBe(502);
  });

  it("returns 502 instead of throwing when the go2rtc request itself fails", async () => {
    const token = issueStreamToken("cam-1");
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const { GET } = await import("./route");
    const res = await GET(new Request(`http://localhost/api/admin/cameras/live?cameraId=cam-1&token=${token}`));
    expect(res.status).toBe(502);
  });
});
