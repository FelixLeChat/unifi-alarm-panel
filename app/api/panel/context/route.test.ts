import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const settings = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/services/settings", () => ({ getSetting: (key: string) => settings.get(key) ?? null }));

function openMeteoResponse(
  overrides: Partial<{
    temp: number;
    code: number;
    hi: number;
    lo: number;
    currentTime: string;
    hourlyTime: string[];
    hourlyTemp: number[];
    hourlyCode: number[];
  }> = {},
) {
  const {
    temp = 23,
    code = 2,
    hi = 25,
    lo = 16,
    currentTime = "2026-09-02T14:00",
    hourlyTime = ["2026-09-02T13:00", "2026-09-02T14:00", "2026-09-02T15:00", "2026-09-02T16:00", "2026-09-02T17:00"],
    hourlyTemp = [24, 23, 22, 21, 20],
    hourlyCode = [1, 2, 2, 1, 0],
  } = overrides;
  return {
    ok: true,
    json: async () => ({
      current: { time: currentTime, temperature_2m: temp, weather_code: code },
      daily: { temperature_2m_max: [hi], temperature_2m_min: [lo] },
      hourly: { time: hourlyTime, temperature_2m: hourlyTemp, weather_code: hourlyCode },
    }),
  };
}

async function freshRoute() {
  vi.resetModules();
  return import("./route");
}

beforeEach(() => {
  settings.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  settings.clear();
});

describe("GET /api/panel/context", () => {
  it("returns null weather fields (and safe defaults) when no coordinates are configured", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await freshRoute();

    const res = await GET();
    const body = await res.json();

    expect(body).toEqual({
      tempC: null,
      condition: null,
      icon: null,
      hiC: null,
      loC: null,
      hourly: [],
      audioEnabled: true,
      quietHoursStart: 22,
      quietHoursEnd: 6,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches and maps the weather when coordinates are configured", async () => {
    settings.set("weatherLat", "45.5");
    settings.set("weatherLon", "-73.6");
    const fetchMock = vi.fn().mockResolvedValue(openMeteoResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await freshRoute();

    const res = await GET();
    const body = await res.json();

    expect(body).toMatchObject({ tempC: 23, condition: "Partly cloudy", icon: "partly-cloudy", hiC: 25, loC: 16 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("45.5");
  });

  // The fixture's hourly array deliberately starts an hour before
  // current.time (13:00, with current.time=14:00) — this proves the slice
  // starts from the matching hour, not from index 0 (which would show a
  // stale/past hour first).
  it("returns the next hours starting at current.time, not the start of the hourly array", async () => {
    settings.set("weatherLat", "45.5");
    settings.set("weatherLon", "-73.6");
    const fetchMock = vi.fn().mockResolvedValue(openMeteoResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await freshRoute();

    const res = await GET();
    const body = await res.json();

    expect(body.hourly).toEqual([
      { hour: "14:00", tempC: 23, icon: "partly-cloudy" },
      { hour: "15:00", tempC: 22, icon: "partly-cloudy" },
      { hour: "16:00", tempC: 21, icon: "clear-day" },
      { hour: "17:00", tempC: 20, icon: "clear-day" },
    ]);
  });

  it("degrades to null fields when the upstream call fails, without throwing", async () => {
    settings.set("weatherLat", "45.5");
    settings.set("weatherLon", "-73.6");
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await freshRoute();

    const res = await GET();
    const body = await res.json();

    expect(body.tempC).toBeNull();
    expect(body.condition).toBeNull();
  });

  it("degrades to null fields when the upstream response doesn't match the expected shape", async () => {
    settings.set("weatherLat", "45.5");
    settings.set("weatherLon", "-73.6");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ unexpected: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await freshRoute();

    const res = await GET();
    const body = await res.json();

    expect(body.tempC).toBeNull();
  });

  it("caches a successful reading and doesn't refetch within the TTL", async () => {
    settings.set("weatherLat", "45.5");
    settings.set("weatherLon", "-73.6");
    const fetchMock = vi.fn().mockResolvedValue(openMeteoResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { GET } = await freshRoute();

    await GET();
    await GET();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("respects audio off and custom quiet hours", async () => {
    settings.set("audioEnabled", "false");
    settings.set("quietHoursStart", "23");
    settings.set("quietHoursEnd", "7");
    const { GET } = await freshRoute();

    const res = await GET();
    const body = await res.json();

    expect(body.audioEnabled).toBe(false);
    expect(body.quietHoursStart).toBe(23);
    expect(body.quietHoursEnd).toBe(7);
  });
});
