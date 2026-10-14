"use client";

import { useEffect, useState, type FormEvent, type RefObject } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { submitPin } from "./api";
import { EYEBROW } from "./shared";

interface ArmPinDialogProps {
  open: boolean;
  kind: "arm" | "disarm";
  /** Where focus goes when the dialog closes: it has no trigger element of its own. */
  finalFocus?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onSuccess: () => void;
}

export function ArmPinDialog({ open, kind, finalFocus, onClose, onSuccess }: ArmPinDialogProps) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [openSensors, setOpenSensors] = useState<{ id: number; name: string }[] | null>(null);

  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setPin("");
      setError(null);
      setSubmitting(false);
      setOpenSensors(null);
    }
  }, [open]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const result = await submitPin(kind, pin, openSensors !== null);
    setSubmitting(false);
    if (result.lockedOut) {
      setError("Too many failed attempts. Locked out. Try again shortly.");
      return;
    }
    if (result.reason === "sensors_open") {
      setOpenSensors(result.openSensors ?? []);
      return;
    }
    if (!result.ok) {
      setError("Incorrect PIN.");
      return;
    }
    onSuccess();
  }

  return (
    <AlertDialog open={open} onOpenChange={(next) => !next && onClose()}>
      <AlertDialogContent finalFocus={finalFocus} className="w-[340px] max-w-[calc(100%-2rem)]">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display text-title-xs font-normal text-foreground">
            {kind === "arm" ? "Arm the system" : "Disarm the system"}
          </AlertDialogTitle>
        </AlertDialogHeader>
        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor="arm-pin" className={EYEBROW}>
              PIN
            </FieldLabel>
            <Input
              id="arm-pin"
              type="password"
              inputMode="numeric"
              autoFocus
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              aria-invalid={error ? true : undefined}
              className="h-10 font-mono text-sm"
            />
            {error && <FieldError>{error}</FieldError>}
          </Field>
          {openSensors && (
            <Alert variant="destructive">
              <AlertDescription>
                {openSensors.length > 0
                  ? `Still open: ${openSensors.map((s) => s.name).join(", ")}. Arm anyway?`
                  : "A door is still open. Arm anyway?"}
              </AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction type="submit" disabled={submitting || pin.length === 0}>
              {openSensors ? "Arm anyway" : kind === "arm" ? "Arm" : "Disarm"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}
