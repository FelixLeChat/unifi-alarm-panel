"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { fetchCameraSnapshotUrl, fetchLiveStreamUrl } from "./api";
import { FullscreenIcon } from "@/components/ui/icons/fullscreen";
import { ProgressActivityIcon } from "@/components/ui/icons/progress-activity";
import { VideocamOffIcon } from "@/components/ui/icons/videocam-off";

/**
 * Tries the live go2rtc stream first, falls back to a static snapshot.
 * Shared between the inline preview and the expanded-view dialog below,
 * which each need their own independently-fetched URL — the live route's
 * stream token is single-use (see lib/auth/stream-token.ts), so two <img>
 * tags can't share one fetchLiveStreamUrl() result.
 */
async function fetchFeedUrl(
  token: string,
  cameraId: string,
  rtspUrl: string | null,
): Promise<{ kind: "live" | "snapshot"; url: string } | null> {
  if (rtspUrl) {
    const url = await fetchLiveStreamUrl(token, cameraId);
    if (url) return { kind: "live", url };
  }
  const url = await fetchCameraSnapshotUrl(token, cameraId);
  return url ? { kind: "snapshot", url } : null;
}

interface CameraFeedProps {
  token: string;
  /** Used for the <img> alt text and the "no camera mapped" caption only. */
  name: string;
  cameraId: string | null;
  rtspUrl: string | null;
  /** Bump to force a re-fetch even though cameraId/rtspUrl haven't changed (e.g. a manual "Refresh" button). */
  refreshKey?: number;
  onLoadingChange?: (loading: boolean) => void;
}

/** The camera preview box (live feed with a static-snapshot fallback) plus its near-fullscreen expand view — used by both the Sensors and Events screens. */
export function CameraFeed({ token, name, cameraId, rtspUrl, refreshKey, onLoadingChange }: CameraFeedProps) {
  const [snapshotUrl, setSnapshotUrl] = useState<string | null>(null);
  // Set only when a live go2rtc stream loaded successfully; takes priority
  // over snapshotUrl below. Not a blob URL (it's the proxy route itself,
  // kept open as a live multipart response), so no revoke.
  const [liveUrl, setLiveUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!cameraId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSnapshotUrl(null);
      setLiveUrl(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    // Clear the previous sensor's frame immediately (not just after the new
    // one resolves) so switching sensors shows a loading state instead of a
    // stale, wrong-camera image while the new feed fetches.
    setSnapshotUrl(null);
    setLiveUrl(null);
    setLoading(true);
    onLoadingChange?.(true);

    fetchFeedUrl(token, cameraId, rtspUrl)
      .then((result) => {
        if (cancelled) {
          if (result?.kind === "snapshot") URL.revokeObjectURL(result.url);
          return;
        }
        setLiveUrl(result?.kind === "live" ? result.url : null);
        if (result?.kind === "snapshot") objectUrl = result.url;
        setSnapshotUrl(result?.kind === "snapshot" ? result.url : null);
      })
      .catch(() => {
        // Network failure: fall through to the camera-off state below instead of a spinner that never ends.
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
        onLoadingChange?.(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cameraId, rtspUrl, token, refreshKey]);

  // The expanded (near-fullscreen) view fetches its own feed URL, on demand
  // when opened, independent from the inline preview above — see
  // fetchFeedUrl's doc comment for why they can't share one.
  const [expandOpen, setExpandOpen] = useState(false);
  const [expandedUrl, setExpandedUrl] = useState<{ kind: "live" | "snapshot"; url: string } | null>(null);

  useEffect(() => {
    if (!expandOpen || !cameraId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setExpandedUrl(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;

    fetchFeedUrl(token, cameraId, rtspUrl)
      .then((result) => {
        if (cancelled) {
          if (result?.kind === "snapshot") URL.revokeObjectURL(result.url);
          return;
        }
        if (result?.kind === "snapshot") objectUrl = result.url;
        setExpandedUrl(result);
      })
      .catch(() => {
        if (!cancelled) setExpandedUrl(null);
      });

    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [expandOpen, cameraId, rtspUrl, token]);

  // The live stream token is single-use and short-lived (see
  // lib/auth/stream-token.ts) — if the <img> connection drops (go2rtc
  // restarted, network blip), retrying the same URL won't work. Fall back to
  // the static snapshot instead of leaving a broken image icon on screen.
  async function handleLiveStreamError() {
    setLiveUrl(null);
    if (!cameraId) return;
    setSnapshotUrl(await fetchCameraSnapshotUrl(token, cameraId));
  }

  return (
    <>
      <div className="relative flex max-h-[320px] items-center justify-center overflow-hidden bg-primary" style={{ aspectRatio: "16/9" }}>
        {liveUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a live MJPEG feed, not a static asset Next's image pipeline should optimize
          <img
            src={liveUrl}
            alt={`${name} live camera feed`}
            // object-contain, not object-cover: this box's 16/9 frame is just
            // a layout convenience, not the camera's actual aspect ratio —
            // cropping to fill it can cut real content out of view, which
            // matters more here than filling the box neatly.
            className="h-full w-full object-contain"
            onError={handleLiveStreamError}
          />
        ) : snapshotUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- a live camera snapshot, not a static asset Next's image pipeline should optimize
          <img src={snapshotUrl} alt={`${name} camera snapshot`} className="h-full w-full object-contain" />
        ) : loading ? (
          <ProgressActivityIcon size={28} className="animate-spin text-muted-foreground" />
        ) : (
          <VideocamOffIcon size={36} className="text-muted-foreground" />
        )}
        <span className="absolute bottom-3 left-3.5 font-mono text-eyebrow-s tracking-eyebrow text-primary-foreground/70 uppercase">
          {cameraId ? `${cameraId}${liveUrl ? " · live" : snapshotUrl ? "" : loading ? " · loading" : " · unreachable"}` : "No Protect camera mapped"}
        </span>
        {(liveUrl || snapshotUrl) && (
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={() => setExpandOpen(true)}
            className="absolute top-3 right-3 h-7 w-7 bg-primary/70 text-muted-foreground hover:text-foreground"
          >
            <FullscreenIcon size={14} />
            <span className="sr-only">Expand</span>
          </Button>
        )}
      </div>

      <Dialog open={expandOpen} onOpenChange={setExpandOpen}>
        <DialogContent
          // Inline style, not a max-w-[92vw] class: DialogContent's own base
          // classes include sm:max-w-md, which beat a same-specificity
          // max-w-none override in the compiled CSS regardless of class
          // order — confirmed by measuring the rendered box (came back
          // 448px, exactly max-w-md, not ~92vw). style always wins.
          style={{ width: "92vw", height: "92vh", maxWidth: "92vw" }}
          className="flex items-center justify-center bg-primary p-0 ring-0"
        >
          <DialogTitle className="sr-only">{name} camera</DialogTitle>
          {expandedUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a live/snapshot camera feed, not a static asset Next's image pipeline should optimize
            <img
              src={expandedUrl.url}
              alt={`${name} camera feed, expanded`}
              className="h-full w-full object-contain"
              onError={() => setExpandedUrl(null)}
            />
          ) : (
            <VideocamOffIcon size={48} className="text-muted-foreground" />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
