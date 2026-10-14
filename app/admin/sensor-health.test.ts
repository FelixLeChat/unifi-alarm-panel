import { describe, expect, it } from "vitest";
import { sensorHealth, type SensorRecord } from "./shared";

function sensor(overrides: Partial<SensorRecord> = {}): SensorRecord {
  return {
    id: 1,
    unifiId: "58D61F49A715",
    name: "Front Door",
    mode: "instant",
    cameraId: null,
    rtspUrl: null,
    sensorType: "door",
    lastTrippedAt: new Date().toISOString(),
    tripCount7d: 70, // ~one trip every 2.4h
    tripCount24h: 10,
    currentState: null,
    device: null,
    ...overrides,
  };
}

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

describe("sensorHealth", () => {
  it("grades silence against the sensor's own cadence, not a fixed clock", () => {
    // Same 24h of silence, two sensors: normal for the one that trips twice a
    // week (a ~3.5-day gap), far outside normal for the one that trips twenty
    // times a day (a ~1.2h gap). The old fixed 12h/72h rule called both yellow.
    const quietByNature = sensor({ tripCount7d: 2, lastTrippedAt: hoursAgo(24) });
    const busyByNature = sensor({ tripCount7d: 140, lastTrippedAt: hoursAgo(24) });
    expect(sensorHealth(quietByNature, false).level).toBe("green");
    expect(sensorHealth(busyByNature, false).level).toBe("red");
  });

  it("stays green for a busy sensor within its normal rhythm", () => {
    expect(sensorHealth(sensor({ tripCount7d: 70, lastTrippedAt: hoursAgo(2) }), false).level).toBe("green");
  });

  // The real incident: the webhook feed died and every sensor rotted
  // independently, which read as six broken sensors rather than one broken
  // feed. Unknown is grey, and the caller states the single cause once.
  it("reports unknown, not red, while the whole feed is stale", () => {
    const verdict = sensorHealth(sensor({ lastTrippedAt: hoursAgo(48), tripCount7d: 70 }), true);
    expect(verdict.level).toBe("unknown");
    expect(verdict.reason).toContain("No sensor feed");
  });

  it("reports unknown for a sensor with no baseline at all", () => {
    expect(sensorHealth(sensor({ lastTrippedAt: null, tripCount7d: 0 }), false).level).toBe("unknown");
    expect(sensorHealth(sensor({ lastTrippedAt: hoursAgo(300), tripCount7d: 0 }), false).level).toBe("unknown");
  });

  // Device liveness outranks trip freshness in both directions: an offline
  // sensor is red however recently it tripped, and it beats even a stale
  // feed, because that one IS a statement about this device.
  it("puts what UniFi says about the device ahead of trip freshness", () => {
    const offline = sensor({ device: { online: false, lastSeenAt: null, batteryPercent: 44, batteryLow: false, tampered: false, signalDbm: -70 } });
    expect(sensorHealth(offline, false).level).toBe("red");
    expect(sensorHealth(offline, true).level).toBe("red");

    const lowBattery = sensor({ device: { online: true, lastSeenAt: null, batteryPercent: 4, batteryLow: true, tampered: false, signalDbm: -70 } });
    expect(sensorHealth(lowBattery, false).level).toBe("yellow");
    expect(sensorHealth(lowBattery, false).reason).toContain("4%");
  });

  // A camera watching a quiet corner can go days without a single trip —
  // that's not a fault. Device health (a direct signal from UniFi) beats
  // the trip-cadence inference entirely, not just for the red/yellow cases.
  it("stays green for a device UniFi reports online even after days of silence", () => {
    const quietCamera = sensor({
      sensorType: null,
      tripCount7d: 0,
      tripCount24h: 0,
      lastTrippedAt: null,
      device: { online: true, lastSeenAt: new Date().toISOString(), batteryPercent: null, batteryLow: false, tampered: false, signalDbm: null },
    });
    const verdict = sensorHealth(quietCamera, false);
    expect(verdict.level).toBe("green");

    // Even with a stale trip feed — device health is independent of it.
    expect(sensorHealth(quietCamera, true).level).toBe("green");
  });
});
