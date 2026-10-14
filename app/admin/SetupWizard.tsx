"use client";

import { useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Logo } from "@/components/ui/logo";
import type { SettingsGroup, SettingsSnapshot } from "./api";
import { SettingsGroupForm } from "./SettingsGroupForm";
import { EYEBROW } from "./shared";

const STEPS: { title: string; intro: string; group?: SettingsGroup }[] = [
  {
    title: "Encryption key",
    intro: "Credentials you enter next are encrypted in the database with SECRETS_KEY, an environment variable only this server knows.",
  },
  {
    title: "UniFi console",
    intro: "Where the console is and how to reach it. Test the connection before moving on.",
    group: "console",
  },
  {
    title: "Notifications",
    intro: "Where alarm, duress and health alerts go. You can skip this and add a channel later under Settings.",
    group: "notifications",
  },
  {
    title: "Kiosk panel",
    intro: "What the wall tablet shows. Every field is optional.",
    group: "panel",
  },
];

interface SetupWizardProps {
  settings: SettingsSnapshot;
  token: string;
  onSettingsSaved: (next: SettingsSnapshot) => void;
  onDone: () => void;
}

/** First run: shown after login while no console is configured. Every step can be skipped. */
export function SetupWizard({ settings, token, onSettingsSaved, onDone }: SetupWizardProps) {
  const [step, setStep] = useState(0);
  const current = STEPS[step];
  const last = step === STEPS.length - 1;
  const next = () => (last ? onDone() : setStep(step + 1));

  return (
    <main className="mx-auto flex min-h-screen max-w-[640px] flex-col gap-6 p-4 md:p-10">
      <div className="flex flex-col gap-3">
        <Logo className="h-7 self-start text-foreground" />
        <div className={EYEBROW}>
          Setup · step {step + 1} of {STEPS.length}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <h1 className="m-0 font-display text-title-xs leading-[1.15] text-foreground">{current.title}</h1>
        <p className="m-0 text-body-s leading-[1.6] text-muted-foreground">{current.intro}</p>
      </div>

      {current.group ? (
        <SettingsGroupForm
          key={current.group}
          group={current.group}
          snapshot={settings}
          token={token}
          onSaved={onSettingsSaved}
          submitLabel={last ? "Save and finish" : "Save and continue"}
          onSubmitted={next}
        />
      ) : (
        <>
          {settings.secretsKey === "ok" ? (
            <Alert>
              <AlertTitle>SECRETS_KEY is set</AlertTitle>
              <AlertDescription>Credentials will be stored encrypted. Keep a copy of the key: without it, stored credentials have to be re-entered.</AlertDescription>
            </Alert>
          ) : (
            <Alert variant="destructive">
              <AlertTitle>{settings.secretsKey === "missing" ? "SECRETS_KEY is not set" : "SECRETS_KEY is invalid"}</AlertTitle>
              <AlertDescription>
                <span>
                  Generate one with <code className="font-mono">openssl rand -base64 32</code>, add it to the server&apos;s environment as <code className="font-mono">SECRETS_KEY</code>, and restart. Until then, credentials (API key, passwords, tokens) can&apos;t be saved.
                </span>
              </AlertDescription>
            </Alert>
          )}
          <div>
            <Button onClick={next}>Continue</Button>
          </div>
        </>
      )}

      <div className="flex gap-4 border-t border-border pt-4">
        {step > 0 && (
          <Button variant="ghost" onClick={() => setStep(step - 1)}>
            Back
          </Button>
        )}
        {current.group && (
          <Button variant="ghost" onClick={next}>
            {last ? "Skip and finish" : "Skip this step"}
          </Button>
        )}
        <Button variant="ghost" className="ml-auto" onClick={onDone}>
          Exit setup
        </Button>
      </div>
    </main>
  );
}
