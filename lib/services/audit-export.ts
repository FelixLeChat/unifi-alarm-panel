import { categorizeAuditEvent, humanizeAuditEvent } from "@/app/admin/audit-copy";
import type { AuditRow } from "./audit";

// Wraps a field in quotes only when needed, doubling any embedded quotes —
// the raw detail JSON and webhook bodies routinely contain commas/newlines.
// A cell that starts with = + - @ or a tab would run as a formula in Excel
// and LibreOffice (actor labels are typed by an admin), so it gets a leading
// apostrophe, the convention both spreadsheets honour.
function csvField(value: string): string {
  const guarded = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  if (!/[",\n\r]/.test(guarded)) return guarded;
  return `"${guarded.replace(/"/g, '""')}"`;
}

// Excel on Windows reads the file as the local code page without it, so accented names come out wrong.
const UTF8_BOM = "\uFEFF";

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
  return UTF8_BOM + lines.join("\r\n") + "\r\n";
}
