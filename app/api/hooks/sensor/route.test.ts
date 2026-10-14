import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { listAudit } from "@/lib/services/audit";
import { POST } from "./route";

const SECRET = "s3cr3t-webhook-token";

beforeEach(() => {
  process.env.DATABASE_PATH = ":memory:";
  process.env.WEBHOOK_SHARED_SECRET = SECRET;
  closeDb();
});

afterEach(() => {
  closeDb();
});

describe("sensor webhook route", () => {
  // A wrong shared secret previously 401'd with zero trace anywhere queryable
  // — recording it here (in addition to the log line in lib/auth/webhook.ts)
  // makes "is UniFi Alarm Manager even reaching this box" answerable from
  // the Audit Log / its CSV export, not just server logs.
  it("records a webhook_rejected audit entry (with source) on a bad secret, not just a 401", async () => {
    const res = await POST(
      new Request("http://localhost/api/hooks/sensor", {
        method: "POST",
        headers: { "x-alarm-secret": "wrong", "x-forwarded-for": "10.0.0.9" },
        body: JSON.stringify({ sensorId: "front-door", eventType: "open" }),
      }),
    );

    expect(res.status).toBe(401);
    const audit = listAudit(getDb(), 10);
    const row = audit.find((a) => a.event === "webhook_rejected");
    expect(row).toBeDefined();
    expect((row?.detail as { source: string } | null)?.source).toBe("10.0.0.9");
  });
});
