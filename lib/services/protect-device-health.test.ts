import { beforeEach, describe, expect, it, vi } from "vitest";

const authedGet = vi.fn();
const getCredentials = vi.fn(() => ({ host: "h", username: "u", password: "p" }));
vi.mock("./protect-alarm-sync", () => ({
  getCredentials: () => getCredentials(),
  getClient: () => ({ authedGet }),
  ProtectAlarmPermissionError: class extends Error {},
}));

const recordAudit = vi.fn();
vi.mock("./audit", () => ({ recordAudit: (...args: unknown[]) => recordAudit(...args) }));
vi.mock("@/lib/db", () => ({ getDb: () => ({}) }));

type SentAlert = { kind: string; message?: string };
const send = vi.fn<(alert: SentAlert) => Promise<void>>(async () => {});
vi.mock("./notifier", () => ({ getNotifier: () => ({ send }) }));

import { checkDeviceHealth, degradations, getDeviceHealthStatus, normalizeMac, toDeviceHealth } from "./protect-device-health";

const online = {
  mac: "58:d6:1f:49:a7:15",
  name: "Front Door",
  isConnected: true,
  lastSeen: 1_700_000_000_000,
  bluetoothConnectionState: { signalStrength: -73 },
};

beforeEach(() => {
  authedGet.mockReset();
  recordAudit.mockReset();
  send.mockReset();
  delete globalThis.__uapDeviceHealth;
});

describe("normalizeMac", () => {
  // UniFi reports a colon-separated lowercase MAC; a webhook reports the
  // bare uppercase one, which is what a sensor row's unifiId is. Matching
  // the two is the entire point of using the private API here.
  it("reduces either spelling to the form a sensor's unifiId uses", () => {
    expect(normalizeMac("58:d6:1f:49:a7:15")).toBe("58D61F49A715");
    expect(normalizeMac("58D61F49A715")).toBe("58D61F49A715");
  });
});

describe("toDeviceHealth", () => {
  it("falls back to the state string when isConnected is absent", () => {
    expect(toDeviceHealth({ mac: "aa:bb", state: "DISCONNECTED" }, "camera")?.online).toBe(false);
    expect(toDeviceHealth({ mac: "aa:bb", state: "CONNECTED" }, "camera")?.online).toBe(true);
  });

  it("skips a device with no MAC — there is nothing to match it to", () => {
    expect(toDeviceHealth({ name: "ghost" }, "sensor")).toBeNull();
  });

  // Whichever radio the device uses, the number the Protect UI draws as bars
  // is the one to report: Bluetooth for a UP-Sense, LoRa for a relay.
  it("reads the signal from whichever radio the device carries", () => {
    expect(toDeviceHealth({ mac: "aa:bb", bluetoothConnectionState: { signalStrength: -63 } }, "sensor")?.signalDbm).toBe(-63);
    expect(
      toDeviceHealth({ mac: "aa:bb", wirelessConnectionState: { signalState: { signalStrength: -91 } } }, "sensor")?.signalDbm,
    ).toBe(-91);
    expect(toDeviceHealth({ mac: "aa:bb" }, "camera")?.signalDbm).toBeNull();
  });
});

describe("degradations", () => {
  const offline = { ...toDeviceHealth(online, "sensor")!, online: false };

  it("reports a device that just went offline", () => {
    expect(degradations({ "58D61F49A715": toDeviceHealth(online, "sensor")! }, { "58D61F49A715": offline })).toHaveLength(1);
  });

  it("stays quiet while it remains offline", () => {
    expect(degradations({ "58D61F49A715": offline }, { "58D61F49A715": offline })).toEqual([]);
  });

  // A restart must not swallow a condition that is still true: with no
  // previous observation at all, a degraded device is still news.
  it("reports a device already degraded on the first poll after a restart", () => {
    expect(degradations({}, { "58D61F49A715": offline })).toHaveLength(1);
  });
});

describe("checkDeviceHealth", () => {
  it("indexes sensors and cameras by normalized MAC", async () => {
    authedGet.mockImplementation((path: string) =>
      path.endsWith("/sensors") ? [online] : [{ mac: "28:70:4e:13:c2:2d", name: "Server Camera", isConnected: true }],
    );
    await checkDeviceHealth();
    const { devices } = getDeviceHealthStatus();
    expect(Object.keys(devices).sort()).toEqual(["28704E13C22D", "58D61F49A715"]);
    expect(devices["58D61F49A715"].kind).toBe("sensor");
  });

  it("alerts and audits a newly offline device", async () => {
    authedGet.mockImplementation((path: string) => (path.endsWith("/sensors") ? [{ ...online, isConnected: false }] : []));
    await checkDeviceHealth();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ kind: "HEALTH" });
    expect(recordAudit.mock.calls[0][1]).toBe("device_health_degraded");
  });

  // A failed poll must not silently blank out the last known device map —
  // "we couldn't ask" is not "everything is fine now".
  it("keeps the previous device map when the poll fails", async () => {
    authedGet.mockImplementation((path: string) => (path.endsWith("/sensors") ? [online] : []));
    await checkDeviceHealth();
    authedGet.mockRejectedValue(new Error("boom"));
    await checkDeviceHealth();
    const status = getDeviceHealthStatus();
    expect(Object.keys(status.devices)).toEqual(["58D61F49A715"]);
    expect(status.error).toContain("boom");
  });
});
