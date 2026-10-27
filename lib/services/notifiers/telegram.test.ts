import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "@/lib/logger";
import { TelegramChannel } from ".";

const TOKEN = "123456:ABC-secret-token";
const channel = () =>
  new TelegramChannel(
    { botToken: TOKEN, chatId: "-1001" },
    { timeZone: "UTC", consoleCamerasUrl: "https://unifi.example/cameras" },
  );
const snapshot = { buffer: Buffer.from([1, 2, 3]), contentType: "image/jpeg" };

describe("TelegramChannel", () => {
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

  it("needs a token and a chat id", () => {
    expect(new TelegramChannel({ botToken: TOKEN }, { timeZone: "UTC" }).isConfigured()).toBe(false);
    expect(new TelegramChannel({ chatId: "1" }, { timeZone: "UTC" }).isConfigured()).toBe(false);
    expect(channel().isConfigured()).toBe(true);
  });

  it("sends a text alert through sendMessage", async () => {
    fetchMock.mockResolvedValue({ ok: true });

    await channel().send({ kind: "ALARM", sensorId: "front-door", at: "2026-09-01T18:32:47.828Z" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    const body = JSON.parse(init.body);
    expect(body.chat_id).toBe("-1001");
    expect(body.text).toContain("Alarm triggered — front-door at 2026-09-01 18:32:47.");
    expect(body.text).toContain("Check the cameras:\nhttps://unifi.example/cameras");
  });

  it("sends a snapshot through sendPhoto with the text as caption, and no separate message", async () => {
    fetchMock.mockResolvedValue({ ok: true });

    await channel().send({ kind: "ALARM", sensorId: "front-door", at: "now", snapshot });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendPhoto`);
    const form = init.body as FormData;
    expect(form.get("chat_id")).toBe("-1001");
    expect(String(form.get("caption"))).toContain("front-door");
    const photo = form.get("photo") as File;
    expect(photo.name).toBe("snapshot.jpg");
    expect(Array.from(new Uint8Array(await photo.arrayBuffer()))).toEqual([1, 2, 3]);
  });

  it("falls back to the text alone when the photo fails", async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith("/sendPhoto")
        ? { ok: false, status: 400, json: async () => ({ description: "Bad Request: wrong file" }) }
        : { ok: true },
    );

    await channel().send({ kind: "DURESS", at: "now", snapshot });

    expect(fetchMock.mock.calls.map((c) => String(c[0]).split("/").pop())).toEqual(["sendPhoto", "sendMessage"]);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).text).toContain("Duress code used");
  });

  it("retries the text once, then gives up without throwing", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const promise = channel().send({ kind: "ALARM", at: "now" });
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(logged).toHaveBeenCalledTimes(1);
  });

  it("test() makes one attempt and throws Telegram's reason", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401, json: async () => ({ description: "Unauthorized" }) });

    await expect(channel().test()).rejects.toThrow("Telegram sendMessage answered 401: Unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never lets the token reach an error message or a log line", async () => {
    // undici repeats the whole URL, token included, when it rejects an invalid one.
    fetchMock.mockRejectedValue(
      new TypeError(`Failed to parse URL from https://api.telegram.org/bot${TOKEN}/sendMessage`),
    );

    const failure = await channel()
      .test()
      .catch((err: Error) => err);
    expect((failure as Error).message).not.toContain(TOKEN);
    expect((failure as Error).message).not.toContain("secret-token");

    const promise = channel().send({ kind: "ALARM", at: "now", snapshot });
    await vi.advanceTimersByTimeAsync(1000);
    await promise;
    expect(
      JSON.stringify(logged.mock.calls, (_k, v) => (v instanceof Error ? { message: v.message, stack: v.stack } : v)),
    ).not.toContain("secret-token");
  });

  it("reports a timeout and a dead network in words", async () => {
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "TimeoutError" }));
    await expect(channel().test()).rejects.toThrow("timed out");
    fetchMock.mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: { code: "ENOTFOUND" } }));
    await expect(channel().test()).rejects.toThrow("ENOTFOUND");
  });
});
