export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { getSetting } from "@/lib/services/settings";

// WMO weather codes (Open-Meteo's `weather_code`) collapsed to a short
// display string + one of panel.js's 7 weather icon keys —
// https://open-meteo.com/en/docs#weather_variable_documentation
export type ConditionIcon = "clear-day" | "partly-cloudy" | "cloudy" | "fog" | "rain" | "snow" | "storm";

const CONDITIONS: Record<number, { text: string; icon: ConditionIcon }> = {
  0: { text: "Clear", icon: "clear-day" },
  1: { text: "Mostly clear", icon: "clear-day" },
  2: { text: "Partly cloudy", icon: "partly-cloudy" },
  3: { text: "Overcast", icon: "cloudy" },
  45: { text: "Fog", icon: "fog" },
  48: { text: "Fog", icon: "fog" },
  51: { text: "Drizzle", icon: "rain" },
  53: { text: "Drizzle", icon: "rain" },
  55: { text: "Drizzle", icon: "rain" },
  56: { text: "Freezing drizzle", icon: "rain" },
  57: { text: "Freezing drizzle", icon: "rain" },
  61: { text: "Rain", icon: "rain" },
  63: { text: "Rain", icon: "rain" },
  65: { text: "Rain", icon: "rain" },
  66: { text: "Freezing rain", icon: "rain" },
  67: { text: "Freezing rain", icon: "rain" },
  71: { text: "Snow", icon: "snow" },
  73: { text: "Snow", icon: "snow" },
  75: { text: "Snow", icon: "snow" },
  77: { text: "Snow grains", icon: "snow" },
  80: { text: "Rain showers", icon: "rain" },
  81: { text: "Rain showers", icon: "rain" },
  82: { text: "Rain showers", icon: "rain" },
  85: { text: "Snow showers", icon: "snow" },
  86: { text: "Snow showers", icon: "snow" },
  95: { text: "Thunderstorm", icon: "storm" },
  96: { text: "Thunderstorm", icon: "storm" },
  99: { text: "Thunderstorm", icon: "storm" },
};
const DEFAULT_CONDITION = { text: "n/a", icon: "cloudy" as ConditionIcon };

const openMeteoSchema = z.object({
  current: z.object({
    time: z.string(),
    temperature_2m: z.number(),
    weather_code: z.number(),
  }),
  daily: z.object({
    temperature_2m_max: z.array(z.number()).min(1),
    temperature_2m_min: z.array(z.number()).min(1),
  }),
  hourly: z.object({
    time: z.array(z.string()),
    temperature_2m: z.array(z.number()),
    weather_code: z.array(z.number()),
  }),
});

export interface HourlyReading {
  hour: string; // "14:00", local to the configured lat/lon
  tempC: number;
  icon: ConditionIcon;
}

export interface WeatherReading {
  tempC: number;
  condition: string;
  icon: ConditionIcon;
  hiC: number;
  loC: number;
  hourly: HourlyReading[];
}

const HOURLY_COUNT = 4;
const CACHE_TTL_MS = 15 * 60 * 1000;
// A failed fetch (null) must not blank the panel for a full TTL.
const FAILURE_TTL_MS = 60 * 1000;
let cache: { at: number; weather: WeatherReading | null } | null = null;

async function fetchWeather(lat: string, lon: string): Promise<WeatherReading | null> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}` +
    `&current=temperature_2m,weather_code&hourly=temperature_2m,weather_code` +
    `&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
  try {
    // Bounded: this is the one outbound call on a kiosk route (see
    // CLAUDE.md's accepted exception), and a hung connection to
    // Open-Meteo would otherwise hold the request open indefinitely.
    const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) {
      logger.warn({ status: res.status }, "Weather API request failed");
      return null;
    }
    const parsed = openMeteoSchema.safeParse(await res.json());
    if (!parsed.success) {
      logger.warn({ err: parsed.error }, "Weather API returned an unexpected shape");
      return null;
    }
    const { current, daily, hourly } = parsed.data;
    const condition = CONDITIONS[current.weather_code] ?? DEFAULT_CONDITION;

    // hourly.time and current.time are both "local to lat/lon" strings from
    // the same request (timezone=auto) — matching them directly sidesteps
    // any UTC-vs-local comparison bugs a Date() diff would risk here.
    let startIdx = hourly.time.indexOf(current.time);
    if (startIdx < 0) startIdx = hourly.time.findIndex((t) => t > current.time);
    if (startIdx < 0) startIdx = 0;
    const nextHours: HourlyReading[] = [];
    for (let i = startIdx; i < Math.min(startIdx + HOURLY_COUNT, hourly.time.length); i++) {
      const hourCondition = CONDITIONS[hourly.weather_code[i]] ?? DEFAULT_CONDITION;
      nextHours.push({ hour: hourly.time[i].slice(11, 16), tempC: Math.round(hourly.temperature_2m[i]), icon: hourCondition.icon });
    }

    return {
      tempC: Math.round(current.temperature_2m),
      condition: condition.text,
      icon: condition.icon,
      hiC: Math.round(daily.temperature_2m_max[0]),
      loC: Math.round(daily.temperature_2m_min[0]),
      hourly: nextHours,
    };
  } catch (err) {
    logger.warn({ err }, "Weather API request threw");
    return null;
  }
}

async function getWeather(): Promise<WeatherReading | null> {
  const lat = getSetting("weatherLat");
  const lon = getSetting("weatherLon");
  if (!lat || !lon) return null;

  if (cache && Date.now() - cache.at < (cache.weather ? CACHE_TTL_MS : FAILURE_TTL_MS)) {
    return cache.weather;
  }
  const weather = await fetchWeather(lat, lon);
  cache = { at: Date.now(), weather };
  return weather;
}

function parseHour(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
}

export async function GET() {
  const weather = await getWeather();
  return NextResponse.json({
    tempC: weather?.tempC ?? null,
    condition: weather?.condition ?? null,
    icon: weather?.icon ?? null,
    hiC: weather?.hiC ?? null,
    loC: weather?.loC ?? null,
    hourly: weather?.hourly ?? [],
    audioEnabled: getSetting("audioEnabled") !== "false",
    quietHoursStart: parseHour(getSetting("quietHoursStart"), 22),
    quietHoursEnd: parseHour(getSetting("quietHoursEnd"), 6),
  });
}
