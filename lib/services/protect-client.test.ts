import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UnifiProtectClient } from "./protect-client";

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("./settings", () => ({ getSetting: (key: string) => settings.get(key) ?? null, getSettingsRevision: () => 0 }));

describe("UnifiProtectClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fetches a snapshot with the X-API-KEY header against the integration API path", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    fetchMock.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "image/jpeg" }),
      arrayBuffer: async () => bytes.buffer,
    });

    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    const snapshot = await client.getSnapshot("cam-1");

    expect(snapshot).not.toBeNull();
    expect(snapshot?.contentType).toBe("image/jpeg");
    expect(Array.from(snapshot!.buffer)).toEqual([1, 2, 3]);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain("/proxy/protect/integration/v1/cameras/cam-1/snapshot");
    expect(init.headers["X-API-KEY"]).toBe("secret-key");
  });

  it("falls back to a standard-quality snapshot when the camera doesn't support highQuality", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        clone: () => ({ text: async () => JSON.stringify({ error: "Camera does not support full HD snapshot", name: "BAD_REQUEST" }) }),
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => bytes.buffer,
      });

    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    const snapshot = await client.getSnapshot("cam-1");

    expect(snapshot).not.toBeNull();
    expect(Array.from(snapshot!.buffer)).toEqual([4, 5, 6]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toContain("highQuality=true");
    expect(fetchMock.mock.calls[1][0]).not.toContain("highQuality");
  });

  it("returns null on a non-2xx response instead of throwing", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    await expect(client.getSnapshot("cam-1")).resolves.toBeNull();
  });

  it("returns null when the request throws (network error) instead of propagating", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    await expect(client.getSnapshot("cam-1")).resolves.toBeNull();
  });

  it("builds the live view URL from the configured template", () => {
    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    expect(client.getLiveViewUrl("cam-1")).toBe("https://udm.local/protect/dashboard/cam-1");
  });

  it("lists cameras from the integration API's /cameras endpoint", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [
        { id: "abc123", name: "Entryway" },
        { id: "def456", name: "Parking Lot" },
      ],
    });

    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    const cameras = await client.listCameras();

    expect(cameras).toEqual([
      { id: "abc123", name: "Entryway" },
      { id: "def456", name: "Parking Lot" },
    ]);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe("https://udm.local/proxy/protect/integration/v1/cameras");
  });

  it("returns an empty camera list instead of throwing on failure", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    await expect(client.listCameras()).resolves.toEqual([]);
  });
});

describe("UnifiProtectClient.triggerAlarmManagerWebhook", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs to the alarm-manager webhook path with the X-API-KEY header", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");

    const ok = await client.triggerAlarmManagerWebhook("webhook-abc");

    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://udm.local/proxy/protect/integration/v1/alarm-manager/webhook/webhook-abc");
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-KEY"]).toBe("secret-key");
  });

  it("returns false instead of throwing when the request fails", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    await expect(client.triggerAlarmManagerWebhook("webhook-abc")).resolves.toBe(false);
  });

  it("returns false on a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    await expect(client.triggerAlarmManagerWebhook("webhook-abc")).resolves.toBe(false);
  });
});

describe("UnifiProtectClient TLS dispatcher scoping", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    settings.clear();
  });

  it("passes no dispatcher — normal certificate verification — by default", async () => {
    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    await client.getSnapshot("cam-1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.dispatcher).toBeUndefined();
  });

  it("scopes a relaxed-TLS dispatcher to this client's fetch calls when insecure TLS is on", async () => {
    settings.set("protectInsecureTls", "true");
    const client = new UnifiProtectClient("https://udm.local", "secret-key", "https://udm.local/protect/dashboard/{cameraId}");
    await client.getSnapshot("cam-1");
    const [, init] = fetchMock.mock.calls[0];
    expect(init.dispatcher).toBeDefined();
  });
});
