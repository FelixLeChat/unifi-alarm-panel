"use client";

import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { saveSettingsGroup, testSettings, type SettingsCheckResult, type SettingsGroup, type SettingsSnapshot } from "./api";
import { EYEBROW } from "./shared";

type FieldKind = "text" | "secret" | "bool" | "pem";

interface FieldSpec {
  key: string;
  label: string;
  hint?: string;
  kind?: FieldKind;
  placeholder?: string;
  inputMode?: "decimal" | "numeric";
  /** What a bool means when nothing is stored. */
  defaultOn?: boolean;
}

interface SectionSpec {
  title?: string;
  description?: string;
  fields: FieldSpec[];
}

export const GROUP_SECTIONS: Record<SettingsGroup, SectionSpec[]> = {
  console: [
    {
      fields: [
        { key: "protectApiBaseUrl", label: "Console URL", placeholder: "https://192.168.1.1", hint: "The UniFi console that runs Protect." },
        { key: "protectApiKey", label: "Protect API key", kind: "secret", hint: "Created on the console under Settings > Control Plane > Integrations." },
        { key: "protectDefaultCameraId", label: "Default camera ID", hint: "Snapshot for alerts from a sensor with no camera of its own." },
        { key: "protectConsoleCamerasUrl", label: "Cameras link in alerts", placeholder: "https://unifi.ui.com/...", hint: "Added to every alert so someone can open the cameras in one tap." },
        { key: "go2rtcApiBaseUrl", label: "go2rtc URL", placeholder: "http://127.0.0.1:1984", hint: "Live camera view in the admin. Leave empty for the default." },
      ],
    },
    {
      title: "SuperAdmin account",
      description: "Optional. Mirrors arming from the UniFi app and adds the console's realtime event stream. UniFi only exposes these to a SuperAdmin.",
      fields: [
        { key: "protectHost", label: "Console host", placeholder: "192.168.1.1" },
        { key: "protectAdminUsername", label: "Username" },
        { key: "protectAdminPassword", label: "Password", kind: "secret" },
      ],
    },
    {
      title: "Certificate",
      description: "The console serves a self-signed certificate. Paste its CA so connections stay verified.",
      fields: [
        { key: "protectCaCert", label: "Console CA certificate (PEM)", kind: "pem", placeholder: "-----BEGIN CERTIFICATE-----" },
        { key: "protectInsecureTls", label: "Skip certificate check", kind: "bool", hint: "Last resort when you can't get the CA. Applies to console calls only." },
        { key: "protectLiveViewUrlTemplate", label: "Live view URL template", placeholder: "https://192.168.1.1/protect/dashboard/{cameraId}", hint: "Link to one camera in alerts. Defaults to the console URL plus /protect/dashboard/{cameraId}." },
      ],
    },
  ],
  notifications: [
    {
      fields: [{ key: "alertTimezone", label: "Timezone for alert times", placeholder: "UTC", hint: "IANA name, like America/New_York or Europe/Paris." }],
    },
    {
      title: "Slack",
      fields: [
        { key: "slackWebhookUrl", label: "Incoming webhook URL", kind: "secret", hint: "Text alerts with the camera links." },
        { key: "slackBotToken", label: "Bot token", kind: "secret", hint: "Optional. With a channel ID, attaches the camera snapshot." },
        { key: "slackChannelId", label: "Channel ID", placeholder: "C0123456789" },
      ],
    },
    {
      title: "ntfy",
      fields: [
        { key: "ntfyUrl", label: "Server URL", placeholder: "https://ntfy.example.com" },
        { key: "ntfyTopic", label: "Topic" },
      ],
    },
  ],
  panel: [
    {
      fields: [
        { key: "helpText", label: "Kiosk help text", placeholder: "Problem? Call Sam at 555-0100", hint: "Shown at the bottom of the kiosk. Empty hides it." },
        { key: "audioEnabled", label: "Kiosk sounds", kind: "bool", defaultOn: true, hint: "Keypad, countdown and siren sounds on the kiosk." },
        { key: "quietHoursStart", label: "Quiet hours start", inputMode: "numeric", placeholder: "22", hint: "Hour (0 to 23). Countdown beeps are softer from here." },
        { key: "quietHoursEnd", label: "Quiet hours end", inputMode: "numeric", placeholder: "6" },
      ],
    },
    {
      title: "Weather",
      description: "The kiosk's weather strip. The server fetches it from Open-Meteo; the kiosk never calls out.",
      fields: [
        { key: "weatherLat", label: "Latitude", inputMode: "decimal", placeholder: "45.50" },
        { key: "weatherLon", label: "Longitude", inputMode: "decimal", placeholder: "-73.57" },
      ],
    },
  ],
};

const TEST_LABEL: Partial<Record<SettingsGroup, string>> = { console: "Test connection", notifications: "Send test alert" };

function initialDraft(group: SettingsGroup, snapshot: SettingsSnapshot): Record<string, string> {
  const draft: Record<string, string> = {};
  for (const section of GROUP_SECTIONS[group]) {
    for (const f of section.fields) {
      if (f.kind === "secret") draft[f.key] = "";
      else if (f.kind === "bool") draft[f.key] = (snapshot.groups[group].values[f.key] ?? String(!!f.defaultOn)) === "true" ? "true" : "false";
      else draft[f.key] = snapshot.groups[group].values[f.key] ?? "";
    }
  }
  return draft;
}

interface SettingsGroupFormProps {
  group: SettingsGroup;
  snapshot: SettingsSnapshot;
  token: string;
  onSaved: (next: SettingsSnapshot) => void;
  /** Wizard: label for the save button, and called after a successful save. */
  submitLabel?: string;
  onSubmitted?: () => void;
}

/** One settings group as a form. Secrets show only whether they are set; typing replaces, Clear removes. */
export function SettingsGroupForm({ group, snapshot, token, onSaved, submitLabel = "Save", onSubmitted }: SettingsGroupFormProps) {
  const [draft, setDraft] = useState(() => initialDraft(group, snapshot));
  const [cleared, setCleared] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SettingsCheckResult[] | null>(null);

  const initial = initialDraft(group, snapshot);
  const changes: Record<string, string | null> = {};
  for (const section of GROUP_SECTIONS[group]) {
    for (const f of section.fields) {
      if (f.kind === "secret") {
        if (cleared.has(f.key)) changes[f.key] = null;
        else if (draft[f.key]) changes[f.key] = draft[f.key];
      } else if (draft[f.key] !== initial[f.key]) {
        changes[f.key] = draft[f.key] === "" ? null : draft[f.key];
      }
    }
  }
  const dirty = Object.keys(changes).length > 0;

  function set(key: string, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setCleared((c) => {
      if (!c.has(key)) return c;
      const next = new Set(c);
      next.delete(key);
      return next;
    });
    setError(null);
  }

  async function save(): Promise<boolean> {
    if (!dirty) return true;
    const result = await saveSettingsGroup(token, group, changes);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    onSaved(result.settings);
    setDraft(initialDraft(group, result.settings));
    setCleared(new Set());
    return true;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const ok = await save();
    setBusy(false);
    if (ok) {
      if (dirty) toast.success("Settings saved");
      onSubmitted?.();
    }
  }

  // Tests always run against what is saved, so unsaved edits are saved first.
  async function handleTest() {
    setBusy(true);
    setResults(null);
    const saved = await save();
    const next = saved ? await testSettings(token, group as "console" | "notifications") : null;
    setBusy(false);
    if (saved && !next) toast.error("The test request didn't go through.");
    setResults(next);
  }

  const secrets = snapshot.groups[group].secrets;

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-6">
      {GROUP_SECTIONS[group].map((section, i) => (
        <div key={section.title ?? i} className="flex flex-col gap-3">
          {section.title && (
            <div className="flex flex-col gap-1">
              <h3 className="m-0 text-body-s font-medium text-foreground">{section.title}</h3>
              {section.description && <p className="m-0 text-body-s leading-[1.6] text-muted-foreground">{section.description}</p>}
            </div>
          )}
          <Card>
            {section.fields.map((f) => {
              const id = `setting-${f.key}`;
              const hintId = f.hint ? `${id}-hint` : undefined;
              if (f.kind === "bool") {
                return (
                  <div key={f.key} className="flex items-start gap-4 border-b border-border p-5 last:border-b-0">
                    <Switch id={id} checked={draft[f.key] === "true"} onCheckedChange={(on) => set(f.key, on ? "true" : "false")} aria-describedby={hintId} />
                    <div className="flex flex-col gap-1">
                      <label htmlFor={id} className="text-body-s font-medium text-foreground">
                        {f.label}
                      </label>
                      {f.hint && (
                        <p id={hintId} className="m-0 text-body-s text-muted-foreground">
                          {f.hint}
                        </p>
                      )}
                    </div>
                  </div>
                );
              }
              const secret = f.kind === "secret" ? secrets[f.key] : undefined;
              const isSet = !!secret?.set && !cleared.has(f.key);
              return (
                <Field key={f.key} className="gap-1.5 border-b border-border p-5 last:border-b-0">
                  <div className="flex items-center gap-2">
                    <FieldLabel htmlFor={id} className={EYEBROW}>
                      {f.label}
                    </FieldLabel>
                    {secret && (
                      <Badge variant={!isSet ? "outline" : secret.readable ? "success" : "warning"}>
                        {!isSet ? "Not set" : secret.readable ? "Set" : "Re-enter"}
                      </Badge>
                    )}
                  </div>
                  {f.kind === "pem" ? (
                    <Textarea
                      id={id}
                      aria-describedby={hintId}
                      value={draft[f.key]}
                      onChange={(e) => set(f.key, e.target.value)}
                      placeholder={f.placeholder}
                      rows={4}
                      className="font-mono text-body-xs"
                    />
                  ) : (
                    <div className="flex gap-2">
                      <Input
                        id={id}
                        aria-describedby={hintId}
                        type={secret ? "password" : "text"}
                        autoComplete={secret ? "new-password" : "off"}
                        inputMode={f.inputMode}
                        value={draft[f.key]}
                        onChange={(e) => set(f.key, e.target.value)}
                        placeholder={secret ? (isSet ? "Stored. Type to replace." : "") : f.placeholder}
                        className="h-10 font-mono text-body-s"
                      />
                      {isSet && (
                        <Button type="button" variant="outline" className="h-10" onClick={() => setCleared((c) => new Set(c).add(f.key))}>
                          Clear
                        </Button>
                      )}
                    </div>
                  )}
                  {f.hint && <FieldDescription id={hintId}>{f.hint}</FieldDescription>}
                </Field>
              );
            })}
          </Card>
        </div>
      ))}

      {error && (
        <p role="alert" className="m-0 text-body-s text-destructive">
          {error}
        </p>
      )}

      {results && (
        <Card aria-live="polite">
          {results.map((r) => (
            <div key={r.name} className="flex items-start gap-3 border-b border-border p-4 last:border-b-0">
              <Badge variant={r.status === "ok" ? "success" : r.status === "failed" ? "destructive" : "outline"}>
                {r.status === "ok" ? "OK" : r.status === "failed" ? "Failed" : "Skipped"}
              </Badge>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-body-s font-medium text-foreground">{r.name}</span>
                <span className="text-body-s break-words text-muted-foreground">{r.detail}</span>
              </div>
            </div>
          ))}
        </Card>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={busy || (!dirty && !onSubmitted)}>
          {submitLabel}
        </Button>
        {TEST_LABEL[group] && (
          <Button type="button" variant="outline" disabled={busy} onClick={handleTest}>
            {TEST_LABEL[group]}
          </Button>
        )}
      </div>
    </form>
  );
}
