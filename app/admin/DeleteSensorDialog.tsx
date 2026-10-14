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

interface DeleteSensorDialogProps {
  name: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DeleteSensorDialog({ name, onCancel, onConfirm }: DeleteSensorDialogProps) {
  return (
    <AlertDialog open={name != null} onOpenChange={(next) => !next && onCancel()}>
      <AlertDialogContent className="w-[420px] max-w-[calc(100%-2rem)]">
        <AlertDialogHeader>
          <AlertDialogTitle className="font-display text-title-xs font-normal text-foreground">{name ? `Delete "${name}"?` : "Delete this sensor?"}</AlertDialogTitle>
          <AlertDialogDescription className="leading-[1.6]">
            {`Its mode and camera mapping are removed. If this device trips again later, it re-registers as a new sensor with the default mode. Its past audit history isn't affected.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" type="button" onClick={onConfirm}>
            Delete sensor
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
