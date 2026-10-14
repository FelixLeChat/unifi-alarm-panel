import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { categorizeAuditEvent, humanizeAuditEvent } from "./audit-copy";

const ROOT = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (full.endsWith(".ts") && !full.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

/**
 * Every audit event this app can actually write, scraped from the source
 * rather than hand-listed — a hand-listed set would drift the moment someone
 * adds an event, which is exactly the bug this guards against.
 *
 * Two shapes produce an audit row: `recordAudit(db, "name")` at a call site,
 * and the pure state machine's `{ type: "AUDIT", event: "name" }` effects.
 */
function emittedAuditEvents(): string[] {
  const events = new Set<string>();
  for (const dir of ["lib", "app", "scripts"]) {
    for (const file of sourceFiles(path.join(ROOT, dir))) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/recordAudit\([^,]+,\s*"([a-z_]+)"/g)) events.add(m[1]);
      if (file.endsWith(path.join("state", "machine.ts"))) {
        for (const m of src.matchAll(/event: "([a-z_]+)"/g)) events.add(m[1]);
      }
    }
  }
  return [...events].sort();
}

describe("audit-copy covers every event the app emits", () => {
  const events = emittedAuditEvents();

  it("found the audit events in the source at all (guards the scraper itself)", () => {
    // Sanity floor: if the regexes ever stop matching, the coverage assertions
    // below would vacuously pass over an empty set.
    expect(events.length).toBeGreaterThan(20);
    expect(events).toContain("armed");
    expect(events).toContain("alarm_instant");
  });

  it.each(events)("humanizes %s into prose, not the raw event name", (event) => {
    const copy = humanizeAuditEvent(event, null);
    expect(copy).not.toBe(event);
    expect(copy.length).toBeGreaterThan(0);
  });

  it.each(events)("categorizes %s into a filter chip", (event) => {
    // A null category makes the row invisible under every chip except "All".
    expect(categorizeAuditEvent(event)).not.toBeNull();
  });
});

describe("humanizeAuditEvent detail rendering", () => {
  it("names the breached profiles a UniFi breach came from", () => {
    const copy = humanizeAuditEvent("protect_breach_detected", {
      profiles: [{ id: "p1", title: "Away", state: "breached" }],
    });
    expect(copy).toContain("Away");
    expect(copy).not.toContain("protect_breach_detected");
  });

  it("names the tag an update was requested for", () => {
    expect(humanizeAuditEvent("update_requested", { tag: "v1.2.3" })).toContain("v1.2.3");
  });

  it("still reads sensibly when the detail is missing", () => {
    expect(humanizeAuditEvent("protect_breach_detected", null)).toBe("UniFi reported a breach");
    expect(humanizeAuditEvent("update_requested", null)).toBe("Update requested");
  });
});
