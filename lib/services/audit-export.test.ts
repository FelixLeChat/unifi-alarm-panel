import { describe, expect, it } from "vitest";
import type { AuditRow } from "./audit";
import { AUDIT_CSV_HEADER, auditRowsToCsv } from "./audit-export";

function row(overrides: Partial<AuditRow> = {}): AuditRow {
  return { id: 1, ts: "2026-01-01T00:00:00.000Z", actorLabel: null, event: "armed", detail: null, ...overrides };
}

describe("auditRowsToCsv", () => {
  it("starts with the header row, CRLF-joined", () => {
    const csv = auditRowsToCsv([]);
    expect(csv).toBe("\uFEFF" + AUDIT_CSV_HEADER.join(",") + "\r\n");
  });

  it("includes the raw detail JSON, not just the humanized description", () => {
    const csv = auditRowsToCsv([row({ event: "sensor_trip_while_disarmed", detail: { sensorId: "front-door" } })]);
    expect(csv).toContain("front-door");
    expect(csv).toContain(JSON.stringify({ sensorId: "front-door" }).replace(/"/g, '""'));
  });

  it("quotes and escapes a field containing a comma or embedded quote", () => {
    const csv = auditRowsToCsv([row({ actorLabel: 'Say "hi", Bob' })]);
    const dataLine = csv.split("\r\n")[1];
    expect(dataLine).toContain('"Say ""hi"", Bob"');
  });

  it("leaves a null actor and null detail as empty fields", () => {
    const csv = auditRowsToCsv([row({ actorLabel: null, detail: null })]);
    const dataLine = csv.split("\r\n")[1];
    const fields = dataLine.split(",");
    expect(fields[2]).toBe(""); // actor
    expect(fields[6]).toBe(""); // detail_json
  });

  it("neutralises a cell that would run as a spreadsheet formula", () => {
    const csv = auditRowsToCsv([row({ actorLabel: "=HYPERLINK(\"http://x\")" })]);
    expect(csv).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(csv).not.toMatch(/,=HYPERLINK/);
  });
});
