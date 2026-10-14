"use client";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

interface RevokeDialogProps {
  label: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function RevokeDialog({ label, onCancel, onConfirm }: RevokeDialogProps) {
  return (
    <AlertDialog open={label != null} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent className="w-[420px] max-w-[calc(100%-2rem)]">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display text-title-xs font-normal text-foreground">{label ? `Revoke "${label}"?` : "Revoke this PIN?"}</AlertDialogTitle>
          <AlertDialogDescription className="leading-[1.6]">
            {`It stops working immediately. If it's the only PIN its holder has, they can't disarm the system until you add a new one.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" type="button" onClick={onConfirm}>
            Revoke PIN
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
