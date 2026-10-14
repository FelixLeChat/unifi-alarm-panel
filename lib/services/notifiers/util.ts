import { logger } from "@/lib/logger";

export const TEST_MESSAGE = "Test alert from UniFi Alarm Panel. If you can read this, alerts reach this channel.";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A single POST that throws on a non-2xx answer or after 10 s. For the test buttons. */
export async function postOnce(url: string, init: RequestInit): Promise<void> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`answered ${res.status}`);
}

/** Retry once after a second, then log and give up: a failed channel never blocks the alarm. */
export async function sendWithRetry(failureMessage: string, attempt: () => Promise<void>): Promise<void> {
  try {
    await attempt();
  } catch {
    await sleep(1000);
    try {
      await attempt();
    } catch (err) {
      logger.error({ err }, failureMessage);
    }
  }
}

/** A short reason for a failed request, without the URL: Node repeats it in some errors. */
export function describeNetworkError(err: unknown): string {
  const cause = (err as { cause?: { code?: string; errors?: { code?: string }[] } })?.cause;
  // A host that resolves to IPv4 and IPv6 fails as an AggregateError with the code on its members.
  const code = cause?.code ?? cause?.errors?.find((e) => e.code)?.code;
  if (code) return code;
  if ((err as Error)?.name === "TimeoutError") return "timed out";
  return err instanceof Error ? err.message : String(err);
}
