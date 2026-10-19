"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { createPin, revokePin } from "./api";
import { PinDetailDialog } from "./PinDetailDialog";
import { RevokeDialog } from "./RevokeDialog";
import { EYEBROW, formatDateOnly, useTransientFlag, type PinSummary } from "./shared";
import { CheckIcon } from "@/components/ui/icons/check";
import { PinIcon } from "@/components/ui/icons/pin";

interface PinsScreenProps {
  pins: PinSummary[];
  token: string;
  onSaved: () => void;
}

type SortKey = "label" | "type" | "status" | "created";
type SortDir = "asc" | "desc";
type StatusFilter = "all" | "active" | "revoked";

const SORT_KEYS: SortKey[] = ["label", "type", "status", "created"];
const STATUS_FILTERS: StatusFilter[] = ["all", "active", "revoked"];
const STATUS_FILTER_LABEL: Record<StatusFilter, string> = { all: "All", active: "Active", revoked: "Revoked" };

function isSortKey(value: string | null): value is SortKey {
  return SORT_KEYS.includes(value as SortKey);
}

function isStatusFilter(value: string | null): value is StatusFilter {
  return STATUS_FILTERS.includes(value as StatusFilter);
}

function comparePins(a: PinSummary, b: PinSummary, sort: SortKey): number {
  switch (sort) {
    case "label":
      return a.label.localeCompare(b.label);
    case "type":
      return Number(a.isDuress) - Number(b.isDuress); // Standard before Duress, ascending.
    case "status":
      return Number(b.active) - Number(a.active); // Active before Revoked, ascending.
    case "created":
      return a.createdAt.localeCompare(b.createdAt); // ISO strings sort correctly as text.
  }
}

function SortHeader({
  sortKey,
  sort,
  dir,
  onSortClick,
  children,
}: {
  sortKey: SortKey;
  sort: SortKey;
  dir: SortDir;
  onSortClick: (key: SortKey) => void;
  children: React.ReactNode;
}) {
  const active = sort === sortKey;
  return (
    <TableHead className="border-b border-border px-4 py-2.5 text-left">
      <button
        type="button"
        onClick={() => onSortClick(sortKey)}
        className={`flex items-center gap-1 ${EYEBROW} ${active ? "text-foreground" : ""}`}
      >
        {children}
        {active && <span aria-hidden="true">{dir === "asc" ? "↑" : "↓"}</span>}
      </button>
    </TableHead>
  );
}

export function PinsScreen({ pins, token, onSaved }: PinsScreenProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // Every bit of table state (sort column/direction, status filter, date
  // range) lives in the URL, not component state — a bookmark, a reload, or
  // a shared link all have to land on the same view.
  const sortParam = searchParams.get("sort");
  const sort: SortKey = isSortKey(sortParam) ? sortParam : "label";
  const dir: SortDir = searchParams.get("dir") === "desc" ? "desc" : "asc";
  const statusParam = searchParams.get("status");
  // Defaults to Active, not All: a revoked PIN is kept only for audit
  // history, not something anyone administering PINs day to day needs to
  // see by default.
  const statusFilter: StatusFilter = isStatusFilter(statusParam) ? statusParam : "active";
  const fromDate = searchParams.get("from") ?? "";
  const toDate = searchParams.get("to") ?? "";
  const hasActiveFilter = statusFilter !== "active" || fromDate !== "" || toDate !== "";

  function updateParams(patch: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") params.delete(key);
      else params.set(key, value);
    }
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  function handleSortClick(key: SortKey) {
    if (sort === key) {
      updateParams({ dir: dir === "asc" ? "desc" : "asc" });
    } else {
      updateParams({ sort: key === "label" ? null : key, dir: null });
    }
  }

  const [label, setLabel] = useState("");
  const [pin, setPin] = useState("");
  const [isDuress, setIsDuress] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<PinSummary | null>(null);
  const [detailTarget, setDetailTarget] = useState<PinSummary | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [justAdded, markAdded] = useTransientFlag();

  function showError(text: string) {
    setPinError(text);
    if (errorTimer.current) clearTimeout(errorTimer.current);
    errorTimer.current = setTimeout(() => setPinError(null), 3500);
  }

  async function handleAddPin(e: FormEvent) {
    e.preventDefault();
    if (!label.trim()) {
      showError("Give the PIN a label.");
      return;
    }
    if (!/^\d{4}$/.test(pin)) {
      showError("PIN must be exactly 4 digits.");
      return;
    }
    const result = await createPin(token, label.trim(), pin, isDuress);
    if (!result.ok) {
      // Deliberately doesn't name whose PIN it collides with — that would leak
      // one employee's code to whoever is adding another.
      showError(result.pinTaken ? "That PIN is already in use. Pick a different one." : "Could not add PIN. Try again.");
      return;
    }
    setLabel("");
    setPin("");
    setIsDuress(false);
    toast.success("PIN added. Active immediately.");
    markAdded();
    onSaved();
  }

  async function handleConfirmRevoke() {
    if (!revokeTarget) return;
    const ok = await revokePin(token, revokeTarget.id).catch(() => false);
    if (!ok) {
      toast.error("Could not revoke the PIN. It still disarms. Try again.");
      return;
    }
    setRevokeTarget(null);
    onSaved();
  }

  const filteredPins = pins.filter((p) => {
    if (statusFilter === "active" && !p.active) return false;
    if (statusFilter === "revoked" && p.active) return false;
    const created = formatDateOnly(p.createdAt);
    if (fromDate && created < fromDate) return false;
    if (toDate && created > toDate) return false;
    return true;
  });
  const sortedPins = [...filteredPins].sort((a, b) => comparePins(a, b, sort) * (dir === "asc" ? 1 : -1));

  return (
    <div className="flex max-w-[960px] flex-col gap-6 p-4 md:p-7">
      <Card className="flex flex-col gap-4.5 p-5.5">
        <div className={EYEBROW}>Add PIN</div>
        <form onSubmit={handleAddPin} className="flex flex-wrap items-end gap-4">
          <Field className="w-[220px]">
            <FieldLabel htmlFor="new-pin-label" className={EYEBROW}>
              Label
            </FieldLabel>
            <Input
              id="new-pin-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Marc D."
              className="w-[220px] text-body-s"
            />
          </Field>
          <Field className="w-[160px]">
            <FieldLabel htmlFor="new-pin-code" className={EYEBROW}>
              PIN · 4 digits
            </FieldLabel>
            <Input
              id="new-pin-code"
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              className="w-[160px] font-mono text-body-s"
            />
          </Field>
          <div className="flex h-9 items-center gap-2.5">
            <Switch checked={isDuress} onCheckedChange={setIsDuress} aria-labelledby="new-pin-duress-label" />
            <span id="new-pin-duress-label" className="text-body-s text-foreground">Duress PIN</span>
            <Tooltip>
              <TooltipTrigger
                type="button"
                aria-label="What is a duress PIN?"
                className="flex h-4 w-4 items-center justify-center rounded-full border border-muted-foreground text-eyebrow-s leading-none text-muted-foreground"
              >
                ?
              </TooltipTrigger>
              <TooltipContent>
                {"Disarms normally, with no visible difference at the door, but silently alerts admins instead of a normal disarm. Example: someone forced to open the office under threat enters their duress PIN like usual. The door unlocks fine, but admins get a silent DURESS alert instead of the usual notification."}
              </TooltipContent>
            </Tooltip>
          </div>
          <Button type="submit" className="w-[100px]">
            {justAdded ? (
              <span className="inline-flex items-center gap-1.5">
                <CheckIcon size={12} />
                Added
              </span>
            ) : (
              "Add PIN"
            )}
          </Button>
          {pinError && <FieldError className="self-center text-xs">{pinError}</FieldError>}
        </form>
        <p className="m-0 max-w-[560px] text-xs leading-[1.55] text-muted-foreground">
          {"A duress PIN disarms the system normally but sends a silent alert. Give one to anyone who opens the office alone."}
        </p>
      </Card>

      {pins.length > 0 && (
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1.5">
            <span className={EYEBROW}>Status</span>
            <div className="flex items-center gap-2">
              {STATUS_FILTERS.map((s) => (
                <Button
                  key={s}
                  type="button"
                  size="sm"
                  variant={s === statusFilter ? "default" : "outline"}
                  onClick={() => updateParams({ status: s === "active" ? null : s })}
                >
                  {STATUS_FILTER_LABEL[s]}
                </Button>
              ))}
            </div>
          </div>
          <Field className="w-[160px]">
            <FieldLabel htmlFor="pins-created-from" className={EYEBROW}>
              Created from
            </FieldLabel>
            <Input
              id="pins-created-from"
              type="date"
              value={fromDate}
              onChange={(e) => updateParams({ from: e.target.value })}
              className="w-[160px] text-body-s"
            />
          </Field>
          <Field className="w-[160px]">
            <FieldLabel htmlFor="pins-created-to" className={EYEBROW}>
              Created to
            </FieldLabel>
            <Input
              id="pins-created-to"
              type="date"
              value={toDate}
              onChange={(e) => updateParams({ to: e.target.value })}
              className="w-[160px] text-body-s"
            />
          </Field>
          {hasActiveFilter && (
            <Button type="button" variant="ghost" size="sm" onClick={() => updateParams({ status: null, from: null, to: null })}>
              Clear filters
            </Button>
          )}
          <span className="ml-auto self-center text-xs text-muted-foreground">
            {sortedPins.length} of {pins.length} PINs
          </span>
        </div>
      )}

      {pins.length > 0 ? (
        <Card className="overflow-hidden">
<Table className="w-full">
          <TableHeader>
            <TableRow>
              <SortHeader sortKey="label" sort={sort} dir={dir} onSortClick={handleSortClick}>
                Label
              </SortHeader>
              <SortHeader sortKey="type" sort={sort} dir={dir} onSortClick={handleSortClick}>
                Type
              </SortHeader>
              <SortHeader sortKey="status" sort={sort} dir={dir} onSortClick={handleSortClick}>
                Status
              </SortHeader>
              <SortHeader sortKey="created" sort={sort} dir={dir} onSortClick={handleSortClick}>
                Created
              </SortHeader>
              <TableHead className="border-b border-border px-4 py-2.5">
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedPins.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="border-b border-border px-4 py-6 text-center text-xs text-muted-foreground">
                  No PINs match these filters.
                </TableCell>
              </TableRow>
            ) : (
              sortedPins.map((p) => (
                <TableRow
                  key={p.id}
                  tabIndex={0}
                  onClick={() => setDetailTarget(p)}
                  // Only Enter on the row itself: Enter on the Revoke button inside it must not also open Edit PIN.
                  onKeyDown={(e) => e.key === "Enter" && e.target === e.currentTarget && setDetailTarget(p)}
                  className={`cursor-pointer ${p.active ? "" : "opacity-55"}`}
                >
                  <TableCell className="border-b border-border px-4 py-3 text-sm font-medium text-foreground">{p.label}</TableCell>
                  <TableCell className="border-b border-border px-4 py-3">
                    {p.isDuress ? (
                      <Badge variant="accent">Duress</Badge>
                    ) : (
                      <span className="text-xs text-muted-foreground">Standard</span>
                    )}
                  </TableCell>
                  <TableCell className="border-b border-border px-4 py-3">
                    {p.active ? (
                      <span className="inline-flex items-center gap-1.5 text-xs text-success">
                        <CheckIcon size={12} />
                        Active
                      </span>
                    ) : (
                      <Badge variant="outline">Revoked</Badge>
                    )}
                  </TableCell>
                  <TableCell className="border-b border-border px-4 py-3 font-mono text-xs text-muted-foreground">
                    {formatDateOnly(p.createdAt)}
                  </TableCell>
                  <TableCell className="border-b border-border px-4 py-3 text-right">
                    {p.active && (
                      <Button
                        size="sm"
                        type="button"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRevokeTarget(p);
                        }}
                        className="text-destructive"
                      >
                        Revoke
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
</Card>
      ) : (
        <Card className="flex flex-col items-center gap-2.5 p-12 text-center">
          <PinIcon size={26} className="text-muted-foreground/40" />
          <div className="text-body-m font-medium text-foreground">No PINs yet</div>
          <p className="m-0 max-w-[380px] text-xs leading-[1.55] text-muted-foreground">
            {"Nobody can disarm the system until at least one PIN exists. Add the first one above."}
          </p>
        </Card>
      )}

      <RevokeDialog label={revokeTarget?.label ?? null} onCancel={() => setRevokeTarget(null)} onConfirm={handleConfirmRevoke} />
      <PinDetailDialog pin={detailTarget} token={token} onClose={() => setDetailTarget(null)} onSaved={onSaved} />
    </div>
  );
}
