import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb } from "@/lib/db";
import { GET } from "./route";

const ADMIN_TOKEN = "test-admin-token";

beforeEach(() => {
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  process.env.DATABASE_PATH = ":memory:";
  closeDb();
  delete globalThis.__uapConnectivityStatus;
});

afterEach(() => {
  closeDb();
});

describe("admin connectivity route", () => {
  it("rejects requests without the admin token", async () => {
    const res = await GET(new Request("http://localhost/api/admin/connectivity"));
    expect(res.status).toBe(401);
  });

  it("returns the current connectivity status without refresh", async () => {
    const res = await GET(new Request("http://localhost/api/admin/connectivity", { headers: { "x-admin-token": ADMIN_TOKEN } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkedAt: string | null };
    expect(body).toHaveProperty("sensorHeartbeatAgeSec");
    expect(body).toHaveProperty("cameraReachable");
  });

  // The admin "Check now" action passes ?refresh=true so the operator doesn't
  // have to wait for the 5-minute job — checkConnectivity() itself is covered
  // in connectivity-watchdog.test.ts, this just proves the route wires it
  // through and returns a freshly-checked status.
  it("GET with ?refresh=true forces a check and advances checkedAt", async () => {
    const res = await GET(new Request("http://localhost/api/admin/connectivity?refresh=true", { headers: { "x-admin-token": ADMIN_TOKEN } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { checkedAt: string | null };
    expect(body.checkedAt).not.toBeNull();
  });
});
