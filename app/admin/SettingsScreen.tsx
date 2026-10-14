"use client";

import { useEffect, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { saveConfigValues, type SettingsGroup, type SettingsSnapshot } from "./api";
import { SettingsGroupForm } from "./SettingsGroupForm";
import { EYEBROW, useTransientFlag } from "./shared";
import { CheckIcon } from "@/components/ui/icons/check";

interface SettingsScreenProps {
  config: Record<string, string>;
  token: string;
  onSaved: () => void;
  settings: SettingsSnapshot | null;
  onSettingsSaved: (next: SettingsSnapshot) => void;
}

const GROUP_TITLES: Record<SettingsGroup, string> = {
  console: "UniFi console",
  notifications: "Notifications",
  panel: "Kiosk panel",
};

// Keys with their own dedicated field elsewhere (Delays screen, the Security
// section below) — excluded from the generic Advanced table so nothing is
// editable in two different places at once.
const KNOWN_KEYS = new Set([
  "exitDelaySec",
  "entryDelaySec",
  "rateLimitMaxAttempts",
  "rateLimitWindowSec",
  "rateLimitLockoutSec",
  // Internal job bookkeeping that happens to live in the same config table,
  // not a setting anyone should tune: editing it would make the audit archive
  // skip or re-run days (see lib/services/audit-archive.ts).
  "lastAuditArchiveDate",
  "panelTestMode",
]);

export function SettingsScreen({ config, token, onSaved, settings, onSettingsSaved }: SettingsScreenProps) {
  const [maxAttempts, setMaxAttempts] = useState(config.rateLimitMaxAttempts ?? "5");
  const [windowSec, setWindowSec] = useState(config.rateLimitWindowSec ?? "300");
  const [lockoutSec, setLockoutSec] = useState(config.rateLimitLockoutSec ?? "300");
  const [saving, setSaving] = useState(false);
  const [justSaved, markSaved] = useTransientFlag();
  // Same race-guard as DelaysScreen: a slow initial admin-snapshot fetch
  // resolving after the user has already started typing must not stomp
  // their in-progress edit back to the stale config value.
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (dirty) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMaxAttempts(config.rateLimitMaxAttempts ?? "5");
    setWindowSec(config.rateLimitWindowSec ?? "300");
    setLockoutSec(config.rateLimitLockoutSec ?? "300");
  }, [config.rateLimitMaxAttempts, config.rateLimitWindowSec, config.rateLimitLockoutSec, dirty]);

  async function handleSaveSecurity(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    const ok = await saveConfigValues(token, {
      rateLimitMaxAttempts: Number(maxAttempts),
      rateLimitWindowSec: Number(windowSec),
      rateLimitLockoutSec: Number(lockoutSec),
    });
    setSaving(false);
    if (ok) {
      setDirty(false);
      toast.success("Security settings saved");
      markSaved();
      onSaved();
    }
  }

  async function handleTestMode(on: boolean) {
    const ok = await saveConfigValues(token, { panelTestMode: on ? "true" : "false" });
    if (ok) {
      toast.success(on ? "Test mode on. Kiosk siren muted." : "Test mode off. Kiosk siren back on.");
      onSaved();
    }
  }

  const advancedEntries = Object.entries(config).filter(([key]) => !KNOWN_KEYS.has(key));

  return (
    <div className="flex max-w-[640px] flex-col gap-8 p-4 md:p-7">
      {settings && settings.secretsKey !== "ok" && (
        <Alert variant="destructive">
          <AlertTitle>{settings.secretsKey === "missing" ? "SECRETS_KEY is not set" : "SECRETS_KEY is invalid"}</AlertTitle>
          <AlertDescription>
            <span>
              Credentials can&apos;t be saved until the server has one. Generate it with <code className="font-mono">openssl rand -base64 32</code>, set <code className="font-mono">SECRETS_KEY</code>, and restart.
            </span>
          </AlertDescription>
        </Alert>
      )}

      {settings &&
        (Object.keys(GROUP_TITLES) as SettingsGroup[]).map((group) => (
          <section key={group} className="flex flex-col gap-4" aria-labelledby={`settings-${group}`}>
            <h2 id={`settings-${group}`} className="m-0 text-body-m font-medium text-foreground">
              {GROUP_TITLES[group]}
            </h2>
            <SettingsGroupForm group={group} snapshot={settings} token={token} onSaved={onSettingsSaved} />
          </section>
        ))}

      <div className="flex flex-col gap-4">
        <h2 className="m-0 text-body-m font-medium text-foreground">Test mode</h2>
        <Card className="flex items-start gap-5 p-5.5">
          <Switch
            checked={config.panelTestMode === "true"}
            onCheckedChange={handleTestMode}
            aria-label="Test mode"
          />
          <p className="m-0 text-body-s leading-[1.6] text-muted-foreground">
            {"The alarm runs every normal step (state changes, Slack and ntfy alerts, snapshots, the UniFi siren) but the kiosk siren stays silent. Every other kiosk sound (keys, countdown beats, chimes) still plays. A banner on the kiosk shows it is on. For the trial period, so the neighbours don't hear it."}
          </p>
        </Card>
      </div>

      <div className="flex flex-col gap-4">
        <h2 className="m-0 text-body-m font-medium text-foreground">Security</h2>
        <Card>
          <Field className="gap-1.5 *:data-[slot=input]:w-[130px] border-b border-border p-5.5">
            <FieldLabel htmlFor="rate-limit-max-attempts" className={EYEBROW}>
              Max attempts
            </FieldLabel>
            <Input
              id="rate-limit-max-attempts" aria-describedby="rate-limit-max-attempts-hint"
              type="number"
              min={1}
              max={20}
              value={maxAttempts}
              onChange={(e) => {
                setMaxAttempts(e.target.value);
                setDirty(true);
              }}
              className="h-10 w-[130px] font-mono text-base"
            />
            <FieldDescription id="rate-limit-max-attempts-hint">{"Wrong PINs, admin tokens, or webhook secrets from the same source before it's locked out."}</FieldDescription>
          </Field>
          <Field className="gap-1.5 *:data-[slot=input]:w-[130px] border-b border-border p-5.5">
            <FieldLabel htmlFor="rate-limit-window-sec" className={EYEBROW}>
              Window · seconds
            </FieldLabel>
            <Input
              id="rate-limit-window-sec" aria-describedby="rate-limit-window-sec-hint"
              type="number"
              min={1}
              max={3600}
              value={windowSec}
              onChange={(e) => {
                setWindowSec(e.target.value);
                setDirty(true);
              }}
              className="h-10 w-[130px] font-mono text-base"
            />
            <FieldDescription id="rate-limit-window-sec-hint">{"Failures older than this stop counting toward the lockout."}</FieldDescription>
          </Field>
          <Field className="gap-1.5 *:data-[slot=input]:w-[130px] p-5.5">
            <FieldLabel htmlFor="rate-limit-lockout-sec" className={EYEBROW}>
              Lockout · seconds
            </FieldLabel>
            <Input
              id="rate-limit-lockout-sec" aria-describedby="rate-limit-lockout-sec-hint"
              type="number"
              min={1}
              max={3600}
              value={lockoutSec}
              onChange={(e) => {
                setLockoutSec(e.target.value);
                setDirty(true);
              }}
              className="h-10 w-[130px] font-mono text-base"
            />
            <FieldDescription id="rate-limit-lockout-sec-hint">{"How long a locked-out source stays locked out once it hits the max."}</FieldDescription>
          </Field>
        </Card>
        <form onSubmit={handleSaveSecurity} className="flex items-center gap-3.5">
          <Button type="submit" disabled={saving} className="w-[110px]">
            {justSaved ? (
              <span className="inline-flex items-center gap-1.5">
                <CheckIcon size={12} />
                Saved
              </span>
            ) : (
              "Save"
            )}
          </Button>
        </form>
      </div>

      <AdvancedSection entries={advancedEntries} token={token} onSaved={onSaved} />
    </div>
  );
}

/**
 * Every other config-table key (webhook payload mapping, camera-trigger
 * event types, the siren automation id, ...) as a generic editable table —
 * automatically covers today's power-user keys and any future one without
 * a maintained list here. Deliberately simpler than the Security section
 * above: each row seeds its own local state once (keyed by config key, so a
 * genuinely new key mounts a fresh row) rather than re-syncing from props on
 * every render, since these are rarely-touched, set-once values with no
 * realistic concurrent-edit race to guard against.
 */
function AdvancedSection({
  entries,
  token,
  onSaved,
}: {
  entries: [string, string][];
  token: string;
  onSaved: () => void;
}) {
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [adding, setAdding] = useState(false);

  async function handleAdd(e: FormEvent) {
    e.preventDefault();
    const key = newKey.trim();
    if (!key) return;
    setAdding(true);
    const ok = await saveConfigValues(token, { [key]: newValue });
    setAdding(false);
    if (ok) {
      setNewKey("");
      setNewValue("");
      toast.success(`Added ${key}`);
      onSaved();
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="m-0 text-body-m font-medium text-foreground">Advanced</h2>
        <p className="m-0 text-body-s leading-[1.6] text-muted-foreground">
          {"Power-user config keys: webhook payload mapping, camera-trigger types, the siren automation ID, and similar. See the README for what each one does."}
        </p>
      </div>
      <Card>
        {entries.length === 0 ? (
          <p className="m-0 p-5.5 text-body-s text-muted-foreground">No advanced keys set yet.</p>
        ) : (
          entries.map(([key, value]) => <AdvancedRow key={key} configKey={key} initialValue={value} token={token} onSaved={onSaved} />)
        )}
      </Card>
      <form onSubmit={handleAdd} className="flex items-end gap-3">
        <Field className="flex-1">
          <FieldLabel htmlFor="new-config-key" className={EYEBROW}>
            Key
          </FieldLabel>
          <Input
            id="new-config-key"
            value={newKey}
            onChange={(e) => setNewKey(e.target.value)}
            placeholder="e.g. cameraTriggerEventTypes"
            className="font-mono text-body-s"
          />
        </Field>
        <Field className="flex-1">
          <FieldLabel htmlFor="new-config-value" className={EYEBROW}>
            Value
          </FieldLabel>
          <Input
            id="new-config-value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="e.g. motion"
            className="font-mono text-body-s"
          />
        </Field>
        <Button
          type="submit"
          disabled={adding || !newKey.trim()}
          className="flex-none"
        >
          Add key
        </Button>
      </form>
    </div>
  );
}

function AdvancedRow({
  configKey,
  initialValue,
  token,
  onSaved,
}: {
  configKey: string;
  initialValue: string;
  token: string;
  onSaved: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [saving, setSaving] = useState(false);
  const [justSaved, markSaved] = useTransientFlag();

  async function handleSave() {
    setSaving(true);
    const ok = await saveConfigValues(token, { [configKey]: value });
    setSaving(false);
    if (ok) {
      markSaved();
      onSaved();
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 border-b border-border p-3 last:border-b-0">
      <span className="w-full flex-none truncate md:w-[220px] font-mono text-body-s text-foreground" title={configKey}>
        {configKey}
      </span>
      <Input
        id={`advanced-config-${configKey}`}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        className="h-8 min-w-0 flex-1 font-mono text-body-s"
      />
      <Button
        size="sm"
        type="button"
        onClick={handleSave}
        disabled={saving}
        className="w-[70px] flex-none"
      >
        {justSaved ? <CheckIcon size={12} /> : "Save"}
      </Button>
    </div>
  );
}
