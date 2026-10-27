"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { saveConfigValues } from "./api";
import { EYEBROW, useTransientFlag } from "./shared";
import { CheckIcon } from "@/components/ui/icons/check";

interface DelaysScreenProps {
  config: Record<string, string>;
  token: string;
  onSaved: () => void;
}

export function DelaysScreen({ config, token, onSaved }: DelaysScreenProps) {
  const [exitVal, setExitVal] = useState(config.exitDelaySec ?? "");
  const [entryVal, setEntryVal] = useState(config.entryDelaySec ?? "");
  const [saving, setSaving] = useState(false);
  const [justSaved, markSaved] = useTransientFlag();
  // Tracks an in-progress, unsaved edit so the resync effect below never
  // clobbers it — without this, a slow initial admin-snapshot fetch (e.g. a
  // deep-linked reload straight onto this screen) that resolves *after* the
  // user has already started typing would stomp their input back to the
  // stale config value. Set on focus, not just on change: a snapshot landing
  // between the click into the field and the first keystroke would otherwise
  // still win, which is how a "45" ended up in the box as "245".
  const [dirty, setDirty] = useState(false);

  // config starts empty until the admin snapshot fetch resolves — resync
  // once it arrives instead of leaving the inputs stuck on the initial empty
  // values, but only while the user hasn't started editing (see `dirty`).
  useEffect(() => {
    if (dirty) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setExitVal(config.exitDelaySec ?? "");
    setEntryVal(config.entryDelaySec ?? "");
  }, [config.exitDelaySec, config.entryDelaySec, dirty]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const ok = await saveConfigValues(token, { exitDelaySec: Number(exitVal), entryDelaySec: Number(entryVal) });
    setSaving(false);
    if (ok) {
      setDirty(false);
      toast.success("Saved. Applies from the next arming.");
      markSaved();
      onSaved();
    }
  }

  return (
    <div className="flex max-w-[640px] flex-col gap-4 p-4 md:p-7">
      <Card>
        <Field className="gap-1.5 *:data-[slot=input]:w-[130px] border-b border-border p-5.5">
          <FieldLabel htmlFor="exit-delay" className={EYEBROW}>
            Exit delay · seconds
          </FieldLabel>
          <Input
            id="exit-delay"
            aria-describedby="exit-delay-hint"
            type="number"
            min={0}
            max={300}
            value={exitVal}
            onFocus={() => setDirty(true)}
            onChange={(e) => {
              setExitVal(e.target.value);
              setDirty(true);
            }}
            className="h-10 w-[130px] font-mono text-base"
          />
          <FieldDescription id="exit-delay-hint">
            {"Time to leave after arming. Delayed sensors won't trip until this runs out."}
          </FieldDescription>
        </Field>
        <Field className="gap-1.5 *:data-[slot=input]:w-[130px] p-5.5">
          <FieldLabel htmlFor="entry-delay" className={EYEBROW}>
            Entry delay · seconds
          </FieldLabel>
          <Input
            id="entry-delay"
            aria-describedby="entry-delay-hint"
            type="number"
            min={0}
            max={300}
            value={entryVal}
            onFocus={() => setDirty(true)}
            onChange={(e) => {
              setEntryVal(e.target.value);
              setDirty(true);
            }}
            className="h-10 w-[130px] font-mono text-base"
          />
          <FieldDescription id="entry-delay-hint">
            {"Time to enter a PIN after a delayed sensor opens, before the siren fires."}
          </FieldDescription>
        </Field>
      </Card>
      <form onSubmit={handleSave} className="flex items-center gap-3.5">
        <Button type="submit" disabled={saving} className="w-[110px]">
          {justSaved ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckIcon size={12} />
              Saved
            </span>
          ) : (
            "Save delays"
          )}
        </Button>
      </form>
      <p className="m-0 text-xs text-muted-foreground">
        {"Changes apply from the next arming. They never shorten a countdown already running."}
      </p>
    </div>
  );
}
