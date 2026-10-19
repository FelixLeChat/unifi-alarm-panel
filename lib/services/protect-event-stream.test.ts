import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProtectClient, TypedEvent } from "unifi-protect";
import { createDb } from "@/lib/db";
import { buildDeviceIndex, classifyStreamEvent, consumeEventStream } from "./protect-event-stream";
import { resetTripDedupe } from "./sensor-ingest";
import { getSensor } from "./sensors";

const CAMERA_ID = "6794912902832303e400042e";
const SENSOR_ID = "65f1a2b3c4d5e6f700010203";
const CAMERA_MAC = "28704E13C8E9";
const SENSOR_MAC = "58D61F49A73B";

const devices = new Map([
  [CAMERA_ID, { mac: CAMERA_MAC, name: "Entrance" }],
  [SENSOR_ID, { mac: SENSOR_MAC, name: "Alarm - Front Door" }],
]);

function patched(id: string, patch: Record<string, unknown>): TypedEvent {
  return { kind: "devicePatched", modelKey: "sensor", id, patch } as TypedEvent;
}

describe("classifyStreamEvent", () => {
  it("turns a camera's motion occurrence into a trip on that camera's MAC", () => {
    const event = { kind: "motionDetected", cameraId: CAMERA_ID, eventId: "e1", at: 1 } as TypedEvent;
    expect(classifyStreamEvent(event, devices)).toEqual({
      unifiId: CAMERA_MAC,
      name: "Entrance",
      isCamera: true,
      trips: true,
    });
  });

  // A UP-Sense doesn't emit an occurrence — its door state arrives as a
  // patch on the device record, which is the whole reason this mapping
  // isn't just "forward every event".
  it("turns a sensor opening into both a trip and an open state", () => {
    expect(classifyStreamEvent(patched(SENSOR_ID, { isOpened: true }), devices)).toEqual({
      unifiId: SENSOR_MAC,
      name: "Alarm - Front Door",
      isCamera: false,
      trips: true,
      openState: "open",
    });
  });

  it("treats a door closing as a state change only — closing is not a breach", () => {
    expect(classifyStreamEvent(patched(SENSOR_ID, { isOpened: false }), devices)).toEqual({
      unifiId: SENSOR_MAC,
      name: "Alarm - Front Door",
      isCamera: false,
      trips: false,
      openState: "closed",
    });
  });

  it("trips on sensor motion", () => {
    expect(classifyStreamEvent(patched(SENSOR_ID, { isMotionDetected: true }), devices)).toMatchObject({
      unifiId: SENSOR_MAC,
      trips: true,
    });
  });

  it("ignores the patches that carry no trip (battery, signal, housekeeping)", () => {
    expect(classifyStreamEvent(patched(SENSOR_ID, { batteryStatus: { percentage: 97 } }), devices)).toBeNull();
    expect(classifyStreamEvent(patched(SENSOR_ID, { isMotionDetected: false }), devices)).toBeNull();
  });

  it("skips a device the index has never heard of rather than inventing a row for it", () => {
    expect(classifyStreamEvent(patched("unknown-id", { isOpened: true }), devices)).toBeNull();
  });
});

describe("buildDeviceIndex", () => {
  // The collections on a state snapshot are id-keyed ReadonlyMaps. Treating
  // them as plain objects yields an empty index and, downstream, a stream
  // that silently classifies nothing — caught once already.
  it("indexes both cameras and sensors by Protect id, MAC normalized", () => {
    const client = {
      state: {
        snapshot: () => ({
          cameras: new Map([[CAMERA_ID, { id: CAMERA_ID, mac: "28:70:4e:13:c8:e9", name: "Entrance" }]]),
          sensors: new Map([[SENSOR_ID, { id: SENSOR_ID, mac: "58:d6:1f:49:a7:3b", name: "Alarm - Front Door" }]]),
        }),
      },
    } as unknown as ProtectClient;

    expect(buildDeviceIndex(client)).toEqual(devices);
  });
});

describe("consumeEventStream", () => {
  let db: Database.Database;
  const handleSensorTrip = vi.fn();
  const engine = { handleSensorTrip } as unknown as Parameters<typeof consumeEventStream>[1]["engine"];

  function fakeClient(events: TypedEvent[]): ProtectClient {
    return {
      state: {
        snapshot: () => ({
          cameras: new Map([[CAMERA_ID, { id: CAMERA_ID, mac: CAMERA_MAC, name: "Entrance" }]]),
          sensors: new Map([[SENSOR_ID, { id: SENSOR_ID, mac: SENSOR_MAC, name: "Alarm - Front Door" }]]),
        }),
      },
      events: async function* () {
        for (const event of events) yield event;
      },
    } as unknown as ProtectClient;
  }

  beforeEach(() => {
    db = createDb(":memory:");
    handleSensorTrip.mockReset();
    resetTripDedupe();
  });

  afterEach(() => db.close());

  it("registers an unknown device and trips the engine with its resolved mode", async () => {
    await consumeEventStream(fakeClient([patched(SENSOR_ID, { isOpened: true })]), { db, engine });

    expect(handleSensorTrip).toHaveBeenCalledWith(SENSOR_MAC, "delayed");
    const sensor = getSensor(db, SENSOR_MAC);
    expect(sensor?.name).toBe("Alarm - Front Door");
    expect(sensor?.currentState).toBe("open");
  });

  it("self-maps a camera's motion trigger to its own camera id, like the webhook path does", async () => {
    const event = { kind: "motionDetected", cameraId: CAMERA_ID, eventId: "e1", at: 1 } as TypedEvent;
    await consumeEventStream(fakeClient([event]), { db, engine });

    expect(getSensor(db, CAMERA_MAC)?.cameraId).toBe(CAMERA_MAC);
  });

  it("records a close without tripping the alarm", async () => {
    await consumeEventStream(fakeClient([patched(SENSOR_ID, { isOpened: false })]), { db, engine });

    expect(handleSensorTrip).not.toHaveBeenCalled();
    expect(getSensor(db, SENSOR_MAC)?.currentState).toBe("closed");
  });

  // One bad event must not end the subscription: that would take the whole
  // second source down, silently, which is the failure mode this source
  // exists to remove.
  it("keeps consuming after a handler throws", async () => {
    const poison = {
      kind: "devicePatched",
      modelKey: "sensor",
      id: SENSOR_ID,
      get patch(): never {
        throw new Error("boom");
      },
    } as unknown as TypedEvent;
    await consumeEventStream(fakeClient([poison, patched(SENSOR_ID, { isOpened: true })]), { db, engine });

    expect(handleSensorTrip).toHaveBeenCalledWith(SENSOR_MAC, "delayed");
  });
});
