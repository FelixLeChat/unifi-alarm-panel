export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { verifyAdminToken } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { recordAudit } from "@/lib/services/audit";
import { checkForUpdate, getUpdateStatus } from "@/lib/services/update-check";

// Same state dir as DATABASE_PATH (see .env.example / unifi-alarm-panel.service).
const stateDir = () => path.dirname(process.env.DATABASE_PATH ?? "./data/alarm.db");
// Set by the Dockerfile. In a container the systemd updater doesn't exist: updating means pulling a new image.
const selfUpdate = () => process.env.UAP_RUNTIME !== "docker";
const markerPath = () => path.join(stateDir(), "update-pending");
const applyStatusPath = () => path.join(stateDir(), "update-status");

function readApplyStatus(): string | null {
  try {
    return readFileSync(applyStatusPath(), "utf8").trim();
  } catch {
    return null;
  }
}

// A marker write is fire-and-forget — apply-pending-update.sh (root, via a
// systemd timer) only picks it up within a minute, and update-status on disk
// doesn't move until it does. Without this, the gap between "requested" and
// "the file on disk actually changed" showed no in-progress state at all —
// the button just looked like it did nothing, so it got double-clicked (two
// update_requested audit entries seconds apart for the same tag). Tracked as
// a synthetic "requested:<tag>" applyStatus, cleared as soon as a GET
// observes the on-disk status has moved (the root script picked it up).
declare global {
  var __uapUpdateRequest: { tag: string; applyStatusSnapshot: string | null } | undefined;
}

function getEffectiveApplyStatus(): string | null {
  const onDisk = readApplyStatus();
  const pending = globalThis.__uapUpdateRequest;
  if (!pending) return onDisk;
  if (onDisk !== pending.applyStatusSnapshot) {
    // The root script picked it up (or something else changed the file) —
    // the real on-disk status is authoritative again.
    globalThis.__uapUpdateRequest = undefined;
    return onDisk;
  }
  return `requested:${pending.tag}`;
}

export async function GET(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  // Normally relies on the hourly scheduled job (lib/services/update-check.ts)
  // — this lets the admin force a check right after cutting a release instead
  // of waiting up to an hour for the next tick.
  if (new URL(req.url).searchParams.get("refresh") === "true") {
    await checkForUpdate();
  }
  return NextResponse.json({ ...getUpdateStatus(), applyStatus: getEffectiveApplyStatus(), selfUpdate: selfUpdate() });
}

// Matches the tags release.yml builds from ("v*") — also the only shape
// deploy/update.sh and apply-pending-update.sh (root, via the marker file)
// should ever act on. This tag ends up in a root-run mkdir/tar/symlink
// chain, so it's a path-traversal vector, not just a cosmetic format check:
// rejecting anything outside this shape (no "/", "..", whitespace) here is
// load-bearing, not optional. apply-pending-update.sh re-checks it too.
const TAG_PATTERN = /^v\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;
const postSchema = z.object({ tag: z.string().trim().regex(TAG_PATTERN).optional() });

/**
 * Doesn't apply anything itself — this process runs unprivileged on purpose
 * (see unifi-alarm-panel.service hardening) and can't touch /opt or
 * restart its own unit. It just drops a marker; a root-owned systemd timer
 * (deploy/apply-pending-update.sh) picks it up within a minute.
 */
export async function POST(req: Request) {
  if (!verifyAdminToken(req)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  if (!selfUpdate()) {
    return NextResponse.json(
      { ok: false, error: "Running in Docker: pull the new image and recreate the container instead." },
      { status: 409 },
    );
  }
  const parsed = postSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const tag = parsed.data.tag ?? getUpdateStatus().latestVersion;
  if (!tag) {
    return NextResponse.json({ ok: false, error: "no target tag known yet" }, { status: 400 });
  }
  if (!TAG_PATTERN.test(tag)) {
    // Only reachable via the latestVersion fallback — a malformed tag_name
    // from the GitHub API response, not user input — but never write it.
    return NextResponse.json({ ok: false, error: "latest known tag has an unexpected shape" }, { status: 400 });
  }

  // An update already in flight (requested-but-not-picked-up, or the root
  // script actively applying one) — reject rather than silently overwriting
  // the marker and logging a second audit entry for what's really one
  // request. This is what a same-tag double-click used to do.
  const inFlight = getEffectiveApplyStatus();
  if (inFlight?.startsWith("requested:") || inFlight?.startsWith("applying:")) {
    return NextResponse.json({ ok: false, error: `an update is already in progress (${inFlight})` }, { status: 409 });
  }

  const applyStatusSnapshot = readApplyStatus();
  writeFileSync(markerPath(), tag);
  globalThis.__uapUpdateRequest = { tag, applyStatusSnapshot };
  recordAudit(getDb(), "update_requested", { detail: { tag } });
  return NextResponse.json({ ok: true, tag });
}
