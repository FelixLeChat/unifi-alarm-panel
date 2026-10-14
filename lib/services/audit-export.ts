import { categorizeAuditEvent, humanizeAuditEvent } from "@/app/admin/audit-copy";
import type { AuditRow } from "./audit";

// Wraps a field in quotes only when needed, doubling any embedded quotes —
// the raw detail JSON and webhook bodies routinely contain commas/newlines.
function csvField(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

export const AUDIT_CSV_HEADER = ["id", "timestamp", "actor", "event", "category", "description", "detail_json"];

/** Shared by the on-demand full-history export route and the daily archive job, so both produce identical CSV. */
export function auditRowsToCsv(rows: AuditRow[]): string {
  const lines = [AUDIT_CSV_HEADER.join(",")];
  for (const row of rows) {
    lines.push(
      [
        String(row.id),
        row.ts,
        row.actorLabel ?? "",
        row.event,
        categorizeAuditEvent(row.event) ?? "",
        humanizeAuditEvent(row.event, row.detail),
        row.detail !== null ? JSON.stringify(row.detail) : "",
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}
