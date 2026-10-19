import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDb } from "@/lib/db";
import { DELETE, GET, PUT } from "./route";

const upsertGo2rtcStream = vi.fn().mockResolvedValue(true);
const removeGo2rtcStream = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/services/go2rtc-client", async (importOriginal) => ({
  // The pure stream-name guard stays real: the schema uses it and the mock must not loosen it.
  ...(await importOriginal<typeof import("@/lib/services/go2rtc-client")>()),
  upsertGo2rtcStream: (...args: unknown[]) => upsertGo2rtcStream(...args),
  removeGo2rtcStream: (...args: unknown[]) => removeGo2rtcStream(...args),
}));

const ADMIN_TOKEN = "test-admin-token";

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  closeDb();
  upsertGo2rtcStream.mockClear();
  removeGo2rtcStream.mockClear();
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

describe("admin config route", () => {
  it("rejects requests without the admin token", async () => {
    const res = await GET(new Request("http://localhost/api/admin/config"));
    expect(res.status).toBe(401);
  });

  it("GET returns the seeded delay defaults", async () => {
    const res = await GET(adminReq("GET", "/api/admin/config"));
    const { config } = (await res.json()) as { config: Record<string, string> };
    expect(config.exitDelaySec).toBeDefined();
    expect(config.entryDelaySec).toBeDefined();
  });

  it("GET's lastArmDisarm is null with no arm/disarm history, and reflects the latest one once there is", async () => {
    const { getDb } = await import("@/lib/db");
    const before = (await (await GET(adminReq("GET", "/api/admin/config"))).json()) as { lastArmDisarm: unknown };
    expect(before.lastArmDisarm).toBeNull();

    getDb()
      .prepare("INSERT INTO audit (actor_label, event) VALUES (?, ?)")
      .run("Alex", "armed");

    const after = (await (await GET(adminReq("GET", "/api/admin/config"))).json()) as {
      lastArmDisarm: { event: string; actorLabel: string | null };
    };
    expect(after.lastArmDisarm).toEqual(expect.objectContaining({ event: "armed", actorLabel: "Alex" }));
  });

  // The Advanced table writes arbitrary key/value pairs straight through, and
  // a NaN or past-32-bit delay reaches setTimeout, which clamps both to ~1ms:
  // no exit delay at all, or an entry delay that alarms the instant a door
  // opens. Both reproduced before this validation existed.
  describe("numeric config validation", () => {
    it.each([
      ["exitDelaySec", "abc"],
      ["entryDelaySec", "3000000"],
      ["entryDelaySec", ""],
      ["exitDelaySec", "-1"],
      ["rateLimitMaxAttempts", "0"],
      ["externalArmSyncDelaySec", "not-a-number"],
    ])("rejects %s = %j with a 400, and doesn't store it", async (key, value) => {
      const res = await PUT(adminReq("PUT", "/api/admin/config", { config: { [key]: value } }));
      expect(res.status).toBe(400);

      const after = (await (await GET(adminReq("GET", "/api/admin/config"))).json()) as { config: Record<string, string> };
      expect(after.config[key]).not.toBe(value);
    });

    it("still accepts sane values, including an explicit zero delay", async () => {
      const res = await PUT(adminReq("PUT", "/api/admin/config", { config: { exitDelaySec: 0, entryDelaySec: 45 } }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { config: Record<string, string> };
      expect(body.config.exitDelaySec).toBe("0");
      expect(body.config.entryDelaySec).toBe("45");
    });

    it("leaves non-numeric keys alone", async () => {
      const res = await PUT(adminReq("PUT", "/api/admin/config", { config: { cameraTriggerEventTypes: "motion" } }));
      expect(res.status).toBe(200);
    });
  });

  it("PUT updates a delay and upserts a sensor mode", async () => {
    const res = await PUT(
      adminReq("PUT", "/api/admin/config", {
        config: { exitDelaySec: 45 },
        sensors: [{ unifiId: "front-door", name: "Front Door", mode: "delayed" }],
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: Record<string, string>;
      sensors: { unifiId: string; mode: string }[];
    };
    expect(body.config.exitDelaySec).toBe("45");
    expect(body.sensors).toContainEqual(expect.objectContaining({ unifiId: "front-door", mode: "delayed" }));
  });

  it("rejects an invalid sensor mode", async () => {
    const res = await PUT(
      adminReq("PUT", "/api/admin/config", {
        sensors: [{ unifiId: "front-door", mode: "not-a-real-mode" }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("rejects a camera ID that isn't a plain ID (it becomes a go2rtc stream name)", async () => {
    const res = await PUT(
      adminReq("PUT", "/api/admin/config", {
        sensors: [{ unifiId: "front-door", mode: "delayed", cameraId: "cam#raw=-f null /tmp/x" }],
      }),
    );
    expect(res.status).toBe(400);
  });

  it("DELETE removes a sensor", async () => {
    await PUT(adminReq("PUT", "/api/admin/config", { sensors: [{ unifiId: "front-door", mode: "delayed" }] }));

    const delRes = await DELETE(adminReq("DELETE", "/api/admin/config?unifiId=front-door"));
    expect(delRes.status).toBe(200);

    const { sensors } = (await (await GET(adminReq("GET", "/api/admin/config"))).json()) as {
      sensors: { unifiId: string }[];
    };
    expect(sensors.find((s) => s.unifiId === "front-door")).toBeUndefined();
  });

  it("DELETE rejects a request with no unifiId", async () => {
    const res = await DELETE(adminReq("DELETE", "/api/admin/config"));
    expect(res.status).toBe(400);
  });

  it("DELETE rejects requests without the admin token", async () => {
    const res = await DELETE(new Request("http://localhost/api/admin/config?unifiId=front-door", { method: "DELETE" }));
    expect(res.status).toBe(401);
  });

  it("PUT registers a go2rtc stream, keyed by cameraId, when a sensor is saved with an rtspUrl", async () => {
    const res = await PUT(
      adminReq("PUT", "/api/admin/config", {
        sensors: [{ unifiId: "front-door", mode: "instant", cameraId: "cam-1", rtspUrl: "rtsps://192.168.1.1:7441/abc" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(upsertGo2rtcStream).toHaveBeenCalledWith("cam-1", "rtsps://192.168.1.1:7441/abc");
  });

  it("PUT removes the go2rtc stream when rtspUrl is explicitly cleared", async () => {
    await PUT(
      adminReq("PUT", "/api/admin/config", {
        sensors: [{ unifiId: "front-door", mode: "instant", cameraId: "cam-1", rtspUrl: "rtsps://192.168.1.1:7441/abc" }],
      }),
    );
    await PUT(
      adminReq("PUT", "/api/admin/config", {
        sensors: [{ unifiId: "front-door", mode: "instant", rtspUrl: null }],
      }),
    );
    expect(removeGo2rtcStream).toHaveBeenCalledWith("cam-1");
  });

  it("PUT does not touch go2rtc when a sensor save omits rtspUrl entirely", async () => {
    await PUT(adminReq("PUT", "/api/admin/config", { sensors: [{ unifiId: "front-door", mode: "delayed" }] }));
    expect(upsertGo2rtcStream).not.toHaveBeenCalled();
    expect(removeGo2rtcStream).not.toHaveBeenCalled();
  });

  it("DELETE removes the go2rtc stream for a deleted sensor that had a live feed", async () => {
    await PUT(
      adminReq("PUT", "/api/admin/config", {
        sensors: [{ unifiId: "front-door", mode: "instant", cameraId: "cam-1", rtspUrl: "rtsps://192.168.1.1:7441/abc" }],
      }),
    );
    removeGo2rtcStream.mockClear();

    await DELETE(adminReq("DELETE", "/api/admin/config?unifiId=front-door"));
    expect(removeGo2rtcStream).toHaveBeenCalledWith("cam-1");
  });

  it("DELETE does not call go2rtc for a sensor with no rtspUrl", async () => {
    await PUT(adminReq("PUT", "/api/admin/config", { sensors: [{ unifiId: "front-door", mode: "delayed" }] }));
    await DELETE(adminReq("DELETE", "/api/admin/config?unifiId=front-door"));
    expect(removeGo2rtcStream).not.toHaveBeenCalled();
  });

  it("accepts a plain rtsp:// rtspUrl, not just rtsps://", async () => {
    const res = await PUT(
      adminReq("PUT", "/api/admin/config", {
        sensors: [{ unifiId: "front-door", mode: "instant", cameraId: "cam-1", rtspUrl: "rtsp://cam.local/stream1" }],
      }),
    );
    expect(res.status).toBe(200);
    expect(upsertGo2rtcStream).toHaveBeenCalledWith("cam-1", "rtsp://cam.local/stream1");
  });

  it("rejects an rtspUrl that isn't an rtsp(s):// URL, without touching go2rtc", async () => {
    const res = await PUT(
      adminReq("PUT", "/api/admin/config", {
        sensors: [{ unifiId: "front-door", mode: "instant", cameraId: "cam-1", rtspUrl: "https://192.168.1.1/some-live-view-link" }],
      }),
    );
    expect(res.status).toBe(400);
    expect(upsertGo2rtcStream).not.toHaveBeenCalled();
  });
});
