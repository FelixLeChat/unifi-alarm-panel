import { logger } from "@/lib/logger";
import { getProtectDispatcher } from "./protect-tls";
import { getSetting, getSettingsRevision } from "./settings";

export interface Snapshot {
  buffer: Buffer;
  contentType: string;
}

export interface ProtectCamera {
  id: string;
  name: string;
}

export interface ProtectClient {
  getSnapshot(cameraId: string): Promise<Snapshot | null>;
  getLiveViewUrl(cameraId: string): string;
  listCameras(): Promise<ProtectCamera[]>;
  triggerAlarmManagerWebhook(webhookId: string): Promise<boolean>;
}

/**
 * UniFi Protect's local Integration API (X-API-KEY auth, base path
 * `/proxy/protect/integration/v1`). On any failure getSnapshot/listCameras
 * return null/[] rather than throwing — a missing snapshot must never stop
 * an alert from going out (see AlarmEngine.runEffect).
 */
export class UnifiProtectClient implements ProtectClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly liveViewUrlTemplate: string,
  ) {}

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const dispatcher = getProtectDispatcher();
    return fetch(`${this.baseUrl}${path}`, {
      ...init,
      // The ALARM path awaits the snapshot before the alert goes out, so a hung console must not hold it for undici's 300s default.
      signal: init.signal ?? AbortSignal.timeout(10_000),
      headers: { "X-API-KEY": this.apiKey, ...init.headers },
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
  }

  async getSnapshot(cameraId: string): Promise<Snapshot | null> {
    const path = `/proxy/protect/integration/v1/cameras/${encodeURIComponent(cameraId)}/snapshot`;
    try {
      let res = await this.fetch(`${path}?highQuality=true`);

      // Not every camera supports full HD snapshots (featureFlags.supportFullHdSnapshot).
      // Rather than plumbing that flag through every getSnapshot() call site, just retry
      // standard-quality on the specific 400 that means "this camera can't do highQuality".
      if (res.status === 400) {
        const body = await res.clone().text();
        if (/does not support full hd/i.test(body) || /BAD_REQUEST/.test(body)) {
          logger.debug({ cameraId }, "Camera doesn't support highQuality snapshot, retrying without it");
          res = await this.fetch(path);
        }
      }

      if (!res.ok) {
        logger.warn({ cameraId, status: res.status }, "Protect snapshot request failed");
        return null;
      }
      const contentType = res.headers.get("content-type") ?? "image/jpeg";
      const buffer = Buffer.from(await res.arrayBuffer());
      return { buffer, contentType };
    } catch (err) {
      logger.warn({ err, cameraId }, "Protect snapshot request threw");
      return null;
    }
  }

  /**
   * Resolves valid local camera `_id`s — the console's cloud UI
   * (unifi.ui.com/consoles/.../protect/devices/<id>) shows a different ID
   * than this local API expects, which is a common source of the snapshot
   * endpoint returning 400. See `pnpm protect:cameras`.
   */
  /** For Settings > Test connection: the camera list request, with the reason it failed instead of an empty list. */
  async probeCameras(): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
    try {
      const res = await this.fetch("/proxy/protect/integration/v1/cameras", { signal: AbortSignal.timeout(10_000) });
      if (res.status === 401 || res.status === 403) return { ok: false, error: `the console rejected the API key (${res.status})` };
      if (!res.ok) return { ok: false, error: `the console answered ${res.status}` };
      const body = (await res.json()) as unknown;
      return { ok: true, count: Array.isArray(body) ? body.length : 0 };
    } catch (err) {
      return { ok: false, error: describeFetchError(err) };
    }
  }

  async listCameras(): Promise<ProtectCamera[]> {
    try {
      const res = await this.fetch("/proxy/protect/integration/v1/cameras");
      if (!res.ok) {
        logger.warn({ status: res.status }, "Protect camera list request failed");
        return [];
      }
      const body = (await res.json()) as Array<{ id: string; name: string }>;
      return body.map((c) => ({ id: c.id, name: c.name }));
    } catch (err) {
      logger.warn({ err }, "Protect camera list request threw");
      return [];
    }
  }

  /**
   * The exact deep-link path for a camera's live view isn't documented
   * anywhere stable enough to hard-code (and depends on the console's own
   * web app routing), so it's a configurable template rather than a guess
   * baked into the code — same reasoning as the webhook payload paths in
   * lib/services/webhook-intake.ts. Override via PROTECT_LIVE_VIEW_URL_TEMPLATE.
   */
  getLiveViewUrl(cameraId: string): string {
    return this.liveViewUrlTemplate.replace("{cameraId}", encodeURIComponent(cameraId));
  }

  /**
   * Fires one of Protect's Alarm Manager *inbound* webhooks — the
   * mechanism for triggering a PoE siren: an
   * automation in Protect's own UI is configured to do something (like
   * firing the siren) when this webhook id is hit. This client only knows
   * how to hit it; what the automation does with that is entirely
   * configured on the console side. Never throws — same reasoning as
   * getSnapshot/listCameras, an unreachable siren must never block the
   * alert itself from going out.
   */
  async triggerAlarmManagerWebhook(webhookId: string): Promise<boolean> {
    try {
      const res = await this.fetch(`/proxy/protect/integration/v1/alarm-manager/webhook/${encodeURIComponent(webhookId)}`, {
        method: "POST",
      });
      if (!res.ok) logger.warn({ webhookId, status: res.status }, "Protect alarm-manager webhook trigger failed");
      return res.ok;
    } catch (err) {
      logger.warn({ err, webhookId }, "Protect alarm-manager webhook trigger threw");
      return false;
    }
  }
}

export class NullProtectClient implements ProtectClient {
  async getSnapshot(): Promise<Snapshot | null> {
    return null;
  }
  getLiveViewUrl(): string {
    return "";
  }
  async listCameras(): Promise<ProtectCamera[]> {
    return [];
  }
  async triggerAlarmManagerWebhook(): Promise<boolean> {
    return false;
  }
}

// Rebuilt when the settings revision moves, so a console change in the
// admin UI applies on the next call without a restart (see settings.ts).
/** A fetch failure as one readable line: undici hides the useful part (ECONNREFUSED, a cert error) in `cause`. */
export function describeFetchError(err: unknown): string {
  const cause = (err as { cause?: { code?: string; message?: string } })?.cause;
  if (cause?.code) return `${cause.code}${cause.message ? `: ${cause.message}` : ""}`;
  if ((err as Error)?.name === "TimeoutError") return "timed out";
  return err instanceof Error ? err.message : String(err);
}

let protectClientCache: { revision: number; client: ProtectClient } | null = null;

export function getProtectClient(): ProtectClient {
  const revision = getSettingsRevision();
  if (!protectClientCache || protectClientCache.revision !== revision) {
    const baseUrl = getSetting("protectApiBaseUrl")?.replace(/\/+$/, "");
    const apiKey = getSetting("protectApiKey");
    const client =
      baseUrl && apiKey
        ? new UnifiProtectClient(baseUrl, apiKey, getSetting("protectLiveViewUrlTemplate") ?? `${baseUrl}/protect/dashboard/{cameraId}`)
        : new NullProtectClient();
    protectClientCache = { revision, client };
  }
  return protectClientCache.client;
}
