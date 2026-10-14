import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeDb, getDb } from "@/lib/db";
import { listAudit } from "@/lib/services/audit";
import { GET, POST } from "./route";

const ADMIN_TOKEN = "test-admin-token";
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "uap-update-test-"));
  process.env.DATABASE_PATH = path.join(tmpDir, "alarm.db");
  process.env.ADMIN_TOKEN = ADMIN_TOKEN;
  closeDb();
  delete globalThis.__uapUpdateRequest;
});

afterEach(() => {
  closeDb();
  rmSync(tmpDir, { recursive: true, force: true });
});

function adminReq(method: string, body?: unknown): Request {
  return new Request("http://localhost/api/admin/update", {
    method,
    headers: { "x-admin-token": ADMIN_TOKEN, "content-type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("admin update route", () => {
  it("rejects requests without the admin token", async () => {
    const res = await GET(new Request("http://localhost/api/admin/update"));
    expect(res.status).toBe(401);
  });

  it("writes the marker file for a well-formed tag", async () => {
    const res = await POST(adminReq("POST", { tag: "v1.2.3" }));
    expect(res.status).toBe(200);
    expect(readFileSync(path.join(tmpDir, "update-pending"), "utf8")).toBe("v1.2.3");
  });

  // The tag ends up in a root-run mkdir/tar/symlink chain (apply-pending-update.sh)
  // — a path-traversal payload here must never reach the marker file.
  it("rejects a path-traversal payload instead of writing the marker", async () => {
    const res = await POST(adminReq("POST", { tag: "../../etc/cron.d/evil" }));
    expect(res.status).toBe(400);
    expect(existsSync(path.join(tmpDir, "update-pending"))).toBe(false);
  });

  it("rejects a tag with shell metacharacters", async () => {
    const res = await POST(adminReq("POST", { tag: "v1.0.0; rm -rf /" }));
    expect(res.status).toBe(400);
    expect(existsSync(path.join(tmpDir, "update-pending"))).toBe(false);
  });

  it("GET surfaces an existing apply-status file", async () => {
    writeFileSync(path.join(tmpDir, "update-status"), "done:v1.2.3");
    const res = await GET(adminReq("GET"));
    const body = (await res.json()) as { applyStatus: string | null };
    expect(body.applyStatus).toBe("done:v1.2.3");
  });

  // apply-pending-update.sh (root, via a systemd timer) only picks up the
  // marker within a minute — before that, update-status on disk hasn't
  // moved at all, so a plain readFileSync gave zero sign a request had even
  // gone through. This is what made a same-tag double-click on the admin UI
  // look like a no-op instead of "already requested".
  it("GET reports a synthetic requested:<tag> status right after POST, before the on-disk status moves", async () => {
    await POST(adminReq("POST", { tag: "v1.2.3" }));
    const res = await GET(adminReq("GET"));
    const body = (await res.json()) as { applyStatus: string | null };
    expect(body.applyStatus).toBe("requested:v1.2.3");
  });

  it("rejects a second POST while the first is still requested-but-unpicked-up, and doesn't double-audit", async () => {
    const first = await POST(adminReq("POST", { tag: "v1.2.3" }));
    expect(first.status).toBe(200);

    const second = await POST(adminReq("POST", { tag: "v1.2.3" }));
    expect(second.status).toBe(409);

    const audit = listAudit(getDb(), 10);
    expect(audit.filter((a) => a.event === "update_requested")).toHaveLength(1);
  });

  it("rejects a POST while the on-disk status already says applying:<tag>", async () => {
    writeFileSync(path.join(tmpDir, "update-status"), "applying:v1.2.3");
    const res = await POST(adminReq("POST", { tag: "v1.2.3" }));
    expect(res.status).toBe(409);
    expect(existsSync(path.join(tmpDir, "update-pending"))).toBe(false);
  });

  it("clears the synthetic requested state once the on-disk status actually changes", async () => {
    await POST(adminReq("POST", { tag: "v1.2.3" }));
    // Simulate apply-pending-update.sh (root) having picked up the marker.
    writeFileSync(path.join(tmpDir, "update-status"), "applying:v1.2.3");

    const res = await GET(adminReq("GET"));
    const body = (await res.json()) as { applyStatus: string | null };
    expect(body.applyStatus).toBe("applying:v1.2.3");

    // The synthetic state is gone, so a new request for a different tag
    // (e.g. once this one finishes) isn't blocked by stale tracking.
    writeFileSync(path.join(tmpDir, "update-status"), "done:v1.2.3");
    const secondPost = await POST(adminReq("POST", { tag: "v1.2.4" }));
    expect(secondPost.status).toBe(200);
  });

  // The admin "Check now" action passes ?refresh=true so the operator doesn't
  // have to wait for the hourly job — checkForUpdate() itself is covered in
  // update-check.test.ts, this just proves the route wires it through and
  // still responds (no github token on the test box, so it's a quiet no-op).
  it("GET with ?refresh=true triggers an update check without erroring", async () => {
    const res = await GET(new Request("http://localhost/api/admin/update?refresh=true", { headers: { "x-admin-token": ADMIN_TOKEN } }));
    expect(res.status).toBe(200);
  });
});
