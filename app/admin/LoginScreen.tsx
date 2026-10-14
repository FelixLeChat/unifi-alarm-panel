"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Logo } from "@/components/ui/logo";
import { EYEBROW } from "./shared";

interface LoginScreenProps {
  tokenInput: string;
  onTokenInputChange: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  error: string | null;
}

export function LoginScreen({ tokenInput, onTokenInputChange, onSubmit, error }: LoginScreenProps) {
  // Deferred to an effect (not read directly) so the server-rendered markup
  // and the first client render match — window.location isn't available
  // during SSR.
  const [host, setHost] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHost(window.location.host);
  }, []);

  return (
    <main className="flex min-h-screen items-center justify-center p-4 md:p-10">
      <div className="flex w-[380px] max-w-full flex-col">
        <Card className="flex flex-col gap-6 px-9 py-10">
          <div className="flex flex-col gap-3">
            <Logo className="h-7 self-start text-foreground" />
            <div className={EYEBROW}>For UniFi Protect</div>
          </div>
          <h1 className="m-0 font-display text-title-xs leading-[1.15] text-foreground">Admin access</h1>
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <Field data-invalid={error ? true : undefined}>
              <FieldLabel htmlFor="admin-token" className={EYEBROW}>
                Access token
              </FieldLabel>
              <Input
                id="admin-token"
                type="password"
                value={tokenInput}
                onChange={(e) => onTokenInputChange(e.target.value)}
                required
                autoFocus
                aria-invalid={error ? true : undefined}
                className="h-10 px-3 font-mono text-sm"
              />
              {error && <FieldError>{error}</FieldError>}
            </Field>
            <Button size="lg" type="submit" className="w-full">
              Enter
            </Button>
          </form>
          <p className="m-0 text-xs leading-[1.55] text-muted-foreground">
            {"LAN only. The token rotates when the controller restarts. Find it in the boot log."}
          </p>
        </Card>
        {host && (
          <div className="px-1 py-3.5 text-center font-mono text-eyebrow-s tracking-eyebrow text-muted-foreground uppercase">
            {host}
          </div>
        )}
      </div>
    </main>
  );
}
