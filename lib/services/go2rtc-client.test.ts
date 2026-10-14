import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb } from "@/lib/db";
import { go2rtcMjpegUrl, removeGo2rtcStream, resyncGo2rtcStreams, toGo2rtcSource, upsertGo2rtcStream } from "./go2rtc-client";
import { upsertSensor } from "./sensors";

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("./settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings")>()),
  getSetting: (key: string) => settings.get(key) ?? null,
}));

describe("toGo2rtcSource", () => {
  it("rewrites rtsps:// to rtspx:// and strips ?enableSrtp, per go2rtc's documented UniFi workaround", () => {
    expect(toGo2rtcSource("rtsps://192.168.1.1:7441/aBcDeFgHiJkLmNoP?enableSrtp")).toBe("rtspx://192.168.1.1:7441/aBcDeFgHiJkLmNoP");
  });

  it("leaves a non-UniFi rtsp:// source untouched aside from query normalization", () => {
    expect(toGo2rtcSource("rtsp://cam.local/stream1")).toBe("rtsp://cam.local/stream1");
  });
});

describe("upsertGo2rtcStream / removeGo2rtcStream", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("PUTs the go2rtc source with rtspx applied and the stream name", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const ok = await upsertGo2rtcStream("cam-1", "rtsps://192.168.1.1:7441/abc?enableSrtp");
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("PUT");
    expect(url).toContain("http://127.0.0.1:1984/api/streams?");
    expect(url).toContain("name=cam-1");
    expect(url).toContain(encodeURIComponent("rtspx://192.168.1.1:7441/abc"));
  });

  /**
   * Verified against a real go2rtc instance: an MJPEG consumer on a
   * stream with only the raw RTSPS producer fails with "codecs not
   * matched: video:H264 => video:JPEG, video:RAW" — a second producer that
   * transcodes via go2rtc's own ffmpeg integration is required. See the
   * doc comment on upsertGo2rtcStream.
   */
  it("also registers an ffmpeg producer that transcodes this stream to MJPEG", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await upsertGo2rtcStream("cam-1", "rtsps://192.168.1.1:7441/abc?enableSrtp");
    const [url] = fetchMock.mock.calls[0];
    const params = new URL(url).searchParams;
    expect(params.getAll("src")).toContain("ffmpeg:cam-1#video=mjpeg");
    expect(params.getAll("src")).toHaveLength(2);
  });

  it("returns false instead of throwing when the go2rtc request fails", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(upsertGo2rtcStream("cam-1", "rtsps://192.168.1.1:7441/abc")).resolves.toBe(false);
  });

  it("DELETEs the stream by name", async () => {
    fetchMock.mockResolvedValue({ ok: true });
    await removeGo2rtcStream("cam-1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(init.method).toBe("DELETE");
    expect(url).toContain("src=cam-1");
  });

  it("swallows a failed removal instead of throwing", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(removeGo2rtcStream("cam-1")).resolves.toBeUndefined();
  });

  it("respects the go2rtc URL setting when set", async () => {
    settings.set("go2rtcApiBaseUrl", "http://go2rtc-host:1984");
    fetchMock.mockResolvedValue({ ok: true });
    await upsertGo2rtcStream("cam-1", "rtsps://192.168.1.1:7441/abc");
    expect(fetchMock.mock.calls[0][0]).toContain("http://go2rtc-host:1984/api/streams?");
    settings.clear();
  });
});

describe("resyncGo2rtcStreams", () => {
  let db: Database.Database;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    db = createDb(":memory:");
    fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    db.close();
    vi.unstubAllGlobals();
  });

  it("re-registers only sensors that have an rtspUrl, keyed by cameraId when mapped", async () => {
    upsertSensor(db, "front-door", "Front Door", "instant", "cam-1", "rtsps://192.168.1.1:7441/a");
    upsertSensor(db, "hallway-motion", "Hallway Motion", "delayed"); // no camera/rtspUrl at all
    upsertSensor(db, "back-door", "Back Door", "instant", null, "rtsp://cam.local/b"); // rtspUrl but no cameraId mapped

    await resyncGo2rtcStreams(db);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const names = fetchMock.mock.calls.map(([url]) => new URL(url as string).searchParams.get("name"));
    expect(names.sort()).toEqual(["back-door", "cam-1"]);
  });

  it("does nothing when no sensor has an rtspUrl", async () => {
    upsertSensor(db, "front-door", "Front Door", "instant");
    await resyncGo2rtcStreams(db);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("go2rtcMjpegUrl", () => {
  it("builds the MJPEG endpoint URL for a stream name", () => {
    expect(go2rtcMjpegUrl("cam-1")).toBe("http://127.0.0.1:1984/api/stream.mjpeg?src=cam-1");
  });
});
