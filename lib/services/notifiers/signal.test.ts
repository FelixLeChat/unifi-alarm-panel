import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { saveSettings } from "../settings";
import { SignalChannel } from ".";

const channel = () =>
  new SignalChannel({ apiUrl: "http://signal-cli:8080", number: "+15145550100", recipients: ["+15145550101", "group.abc="] }, { timeZone: "UTC" });
const snapshot = { buffer: Buffer.from([1, 2, 3]), contentType: "image/jpeg" };

describe("SignalChannel", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let logged: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    logged = vi.spyOn(logger, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("needs a URL, a sender and at least one recipient", () => {
    expect(new SignalChannel({ apiUrl: "http://x", number: "+1" }, { timeZone: "UTC" }).isConfigured()).toBe(false);
    expect(new SignalChannel({ apiUrl: "http://x", number: "+1", recipients: [] }, { timeZone: "UTC" }).isConfigured()).toBe(false);
    expect(channel().isConfigured()).toBe(true);
  });

  it("posts a text alert to /v2/send in the container's request shape", async () => {
    fetchMock.mockResolvedValue({ ok: true });

    await channel().send({ kind: "ALARM", sensorId: "front_door", at: "2026-09-01T18:32:47.828Z" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://signal-cli:8080/v2/send");
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ number: "+15145550100", recipients: ["+15145550101", "group.abc="], text_mode: "normal" });
    expect(body.message).toContain("front_door");
    expect(body.base64_attachments).toBeUndefined();
  });

  it("attaches the snapshot as a base64 data URI with a filename", async () => {
    fetchMock.mockResolvedValue({ ok: true });

    await channel().send({ kind: "ALARM", at: "now", snapshot });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).base64_attachments).toEqual([
      `data:image/jpeg;filename=snapshot.jpg;base64,${Buffer.from([1, 2, 3]).toString("base64")}`,
    ]);
  });

  it("falls back to the text alone when the attachment is refused", async () => {
    fetchMock.mockImplementation(async (_url: string, init: { body: string }) =>
      JSON.parse(init.body).base64_attachments ? { ok: false, status: 400, json: async () => ({ error: "bad attachment" }) } : { ok: true },
    );

    await channel().send({ kind: "DURESS", at: "now", snapshot });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).message).toContain("Duress code used");
  });

  it("retries the text once, then gives up without throwing", async () => {
    fetchMock.mockRejectedValue(new Error("down"));

    const promise = channel().send({ kind: "HEALTH", message: "feed quiet", at: "now" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("test() makes one attempt and throws the container's reason", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, json: async () => ({ error: "Specified account does not exist" }) });
    await expect(channel().test()).rejects.toThrow("Signal API answered 400: Specified account does not exist");

    fetchMock.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNREFUSED" } }));
    await expect(channel().test()).rejects.toThrow("Signal API unreachable: ECONNREFUSED");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Signal settings", () => {
  beforeEach(() => {
    process.env.DATABASE_PATH = ":memory:";
  });

  it("accepts numbers and group ids, and rejects anything else", () => {
    expect(saveSettings("notifications", { signalNumber: "+15145550100", signalRecipients: "+15145550101, group.AbC+/=" }).ok).toBe(true);
    expect(saveSettings("notifications", { signalNumber: "5145550100" }).ok).toBe(false);
    expect(saveSettings("notifications", { signalRecipients: "+15145550101, bob" }).ok).toBe(false);
    expect(saveSettings("notifications", { signalApiUrl: "signal-cli:8080" }).ok).toBe(false);
  });
});
