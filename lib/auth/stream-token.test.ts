import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  delete globalThis.__uapStreamTokens;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("issueStreamToken / consumeStreamToken", () => {
  it("accepts a token issued for the matching cameraId", async () => {
    const { issueStreamToken, consumeStreamToken } = await import("./stream-token");
    const token = issueStreamToken("cam-1");
    expect(consumeStreamToken(token, "cam-1")).toBe(true);
  });

  it("rejects a token issued for a different cameraId", async () => {
    const { issueStreamToken, consumeStreamToken } = await import("./stream-token");
    const token = issueStreamToken("cam-1");
    expect(consumeStreamToken(token, "cam-2")).toBe(false);
  });

  it("rejects an unknown token", async () => {
    const { consumeStreamToken } = await import("./stream-token");
    expect(consumeStreamToken("not-a-real-token", "cam-1")).toBe(false);
  });

  it("is single-use — a second consume of the same token fails even with the right cameraId", async () => {
    const { issueStreamToken, consumeStreamToken } = await import("./stream-token");
    const token = issueStreamToken("cam-1");
    expect(consumeStreamToken(token, "cam-1")).toBe(true);
    expect(consumeStreamToken(token, "cam-1")).toBe(false);
  });

  it("rejects a token past its TTL", async () => {
    vi.useFakeTimers();
    const { issueStreamToken, consumeStreamToken } = await import("./stream-token");
    const token = issueStreamToken("cam-1");
    vi.advanceTimersByTime(31_000);
    expect(consumeStreamToken(token, "cam-1")).toBe(false);
  });

  /**
   * The live-token route (issuer) and the live route (consumer) are two
   * different route handlers — separate Turbopack/webpack bundles, same
   * class of bug as webhook-intake.ts and update-check.ts. Simulate that
   * split with vi.resetModules() between issue and consume to prove the
   * globalThis-backed map survives it.
   */
  it("survives a fresh module import, simulating the issuer and consumer being separate bundles", async () => {
    const issuer = await import("./stream-token");
    const token = issuer.issueStreamToken("cam-1");

    vi.resetModules();
    const consumer = await import("./stream-token");
    expect(consumer.consumeStreamToken(token, "cam-1")).toBe(true);
  });
});
