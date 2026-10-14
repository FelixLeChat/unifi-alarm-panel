"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { downloadAuditLog, fetchAuditPage } from "./api";
import { categorizeAuditEvent, humanizeAuditEvent, type AuditCategory } from "./audit-copy";
import { EYEBROW, formatAuditTimestamp, type AuditRow } from "./shared";

interface AuditLogScreenProps {
  token: string;
}

const CATEGORIES: Array<AuditCategory | "All"> = ["All", "Arming", "Sensors", "PINs", "Config"];
const PAGE_SIZE = 100;

export function AuditLogScreen({ token }: AuditLogScreenProps) {
  const [filter, setFilter] = useState<AuditCategory | "All">("All");
  const [downloading, setDownloading] = useState(false);
  const [audit, setAudit] = useState<AuditRow[]>([]);
  const [loading, setLoading] = useState(true);
  // Stack of the `before` cursor used to fetch each page reached via
  // "Older" — the last entry is the current page's cursor (undefined for
  // page 1). "Newer" pops back to the previous one instead of tracking a
  // separate forward cursor, since `before` only ever pages backward in time.
  const [pageCursors, setPageCursors] = useState<(number | undefined)[]>([undefined]);
  const page = pageCursors.length;

  useEffect(() => {
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    fetchAuditPage(token, PAGE_SIZE, pageCursors[pageCursors.length - 1]).then((rows) => {
      if (cancelled) return;
      setAudit(rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [token, pageCursors]);

  const rows = filter === "All" ? audit : audit.filter((r) => categorizeAuditEvent(r.event) === filter);
  const hasOlder = audit.length === PAGE_SIZE;
  const hasNewer = pageCursors.length > 1;

  function handleOlder() {
    const oldestId = audit[audit.length - 1]?.id;
    if (!oldestId) return;
    setPageCursors((cursors) => [...cursors, oldestId]);
  }

  function handleNewer() {
    setPageCursors((cursors) => (cursors.length > 1 ? cursors.slice(0, -1) : cursors));
  }

  async function handleDownload() {
    setDownloading(true);
    await downloadAuditLog(token);
    setDownloading(false);
  }

  return (
    <div className="flex max-w-[1040px] flex-col gap-4 p-4 md:p-7">
      <div className="flex flex-wrap items-center gap-2">
        {CATEGORIES.map((c) => (
          <Button
            key={c}
            type="button"
            size="sm"
            variant={c === filter ? "default" : "outline"}
            onClick={() => setFilter(c)}
          >
            {c}
          </Button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground">
          {loading ? "Loading…" : `${rows.length} of ${audit.length} events on this page`}
        </span>
        <Button
          variant="secondary"
          size="sm"
          type="button"
          disabled={downloading}
          onClick={handleDownload}
          title="Exports the 200 most recent events. For the full history, see the daily archive files on disk."
        >
          {downloading ? "Downloading…" : "Download CSV (last 200)"}
        </Button>
      </div>

      <Card className="overflow-hidden">
<Table className="w-full">
        <TableHeader>
          <TableRow>
            <TableHead className={`${EYEBROW} w-[190px] border-b border-border px-4 py-2.5 text-left`}>Timestamp</TableHead>
            <TableHead className={`${EYEBROW} w-[140px] border-b border-border px-4 py-2.5 text-left`}>Actor</TableHead>
            <TableHead className={`${EYEBROW} border-b border-border px-4 py-2.5 text-left`}>Event</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={3} className="border-b border-border px-4 py-6 text-center text-xs text-muted-foreground">
                {loading ? <Skeleton className="mx-auto h-4 w-40" /> : "No events on this page."}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="border-b border-border px-4 py-2.75 font-mono text-xs whitespace-nowrap text-muted-foreground">
                  {formatAuditTimestamp(r.ts)}
                </TableCell>
                <TableCell className="border-b border-border px-4 py-2.75 text-body-s font-medium text-foreground">
                  {r.actorLabel ?? ""}
                </TableCell>
                <TableCell className="border-b border-border px-4 py-2.75 text-body-s text-foreground">
                  {humanizeAuditEvent(r.event, r.detail)}
                  {r.detail != null && (
                    <div className="mt-1 truncate font-mono text-body-xs text-muted-foreground" title={JSON.stringify(r.detail)}>
                      {JSON.stringify(r.detail)}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
</Card>

      <div className="flex items-center gap-3">
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={!hasNewer || loading}
          onClick={handleNewer}
        >
          ← Newer
        </Button>
        <span className="font-mono text-body-xs text-muted-foreground">Page {page}</span>
        <Button
          size="sm"
          type="button"
          variant="outline"
          disabled={!hasOlder || loading}
          onClick={handleOlder}
        >
          Older →
        </Button>
      </div>

      <p className="m-0 text-xs text-muted-foreground">
        Read-only, and permanent. The audit trail is append-only and is never pruned from here. This table pages{" "}
        {PAGE_SIZE} events at a time; Download CSV exports the 200 most recent, with the raw detail for every event.
        For the full history, complete days also get archived to a dated CSV on disk automatically (see deploy docs),
        independent of this view.
      </p>
    </div>
  );
}
