"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Switch } from "@/components/ui/switch";
import { updatePin } from "./api";
import { EYEBROW, formatAuditTimestamp, type PinSummary } from "./shared";

interface PinDetailDialogProps {
  pin: PinSummary | null;
  token: string;
  onClose: () => void;
  onSaved: () => void;
}

export function PinDetailDialog({ pin, token, onClose, onSaved }: PinDetailDialogProps) {
  const [label, setLabel] = useState("");
  const [newPin, setNewPin] = useState("");
  const [isDuress, setIsDuress] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!pin) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLabel(pin.label);
    setNewPin("");
    setIsDuress(pin.isDuress);
    setError(null);
  }, [pin]);

  async function handleSave() {
    if (!pin) return;
    if (!label.trim()) {
      setError("Give the PIN a label.");
      return;
    }
    if (newPin && !/^\d{4}$/.test(newPin)) {
      setError("PIN must be exactly 4 digits.");
      return;
    }

    setSaving(true);
    setError(null);
    const result = await updatePin(token, pin.id, {
      label: label.trim(),
      pin: newPin || undefined,
      isDuress,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.pinTaken ? "That PIN is already in use. Pick a different one." : "Could not save. Try again.");
      return;
    }
    onSaved();
    onClose();
  }

  return (
    <Dialog open={pin != null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent showCloseButton={false} className="w-[420px] max-w-[calc(100%-2rem)]">
        <DialogHeader>
          <DialogTitle className="font-display text-title-xs text-foreground">Edit PIN</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <Field>
            <FieldLabel htmlFor="pin-detail-label" className={EYEBROW}>
              Label
            </FieldLabel>
            <Input
              id="pin-detail-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="text-body-s"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="pin-detail-code" className={EYEBROW}>
              New PIN · 4 digits
            </FieldLabel>
            <Input
              id="pin-detail-code"
              type="password"
              inputMode="numeric"
              maxLength={4}
              value={newPin}
              onChange={(e) => setNewPin(e.target.value)}
              placeholder="Leave blank to keep the current PIN"
              className="font-mono text-body-s"
            />
          </Field>
          <div className="flex h-9 items-center gap-2.5">
            <Switch checked={isDuress} onCheckedChange={setIsDuress} aria-labelledby="pin-detail-duress-label" />
            <span id="pin-detail-duress-label" className="text-body-s text-foreground">
              Duress PIN
            </span>
          </div>
          {pin && (
            <div className="flex flex-col gap-1 border-t border-border pt-3.5 font-mono text-body-xs text-muted-foreground">
              <span>Created {formatAuditTimestamp(pin.createdAt)}</span>
              <span>Updated {formatAuditTimestamp(pin.updatedAt)}</span>
            </div>
          )}
          {error && <FieldError className="text-xs">{error}</FieldError>}
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" onClick={handleSave} disabled={saving}>
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
