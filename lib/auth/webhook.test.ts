import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "s3cr3t-webhook-token";
const originalEnv = process.env.WEBHOOK_SHARED_SECRET;

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/hooks/sensor", { headers });
}

beforeEach(() => {
  // Fresh module graph per test so the rate-limit bucket it shares with
  // ./admin and lib/services/rate-limit doesn't leak state across tests.
  vi.resetModules();
  process.env.WEBHOOK_SHARED_SECRET = SECRET;
});

afterEach(() => {
  process.env.WEBHOOK_SHARED_SECRET = originalEnv;
});

describe("verifyWebhookSecret", () => {
  it("accepts the correct header", async () => {
    const { verifyWebhookSecret } = await import("./webhook");
    expect(verifyWebhookSecret(req({ "x-alarm-secret": SECRET }), new URL("http://localhost/x"))).toBe(
      true,
    );
  });

  it("accepts the correct ?token= query param", async () => {
    const { verifyWebhookSecret } = await import("./webhook");
    const url = new URL(`http://localhost/api/hooks/sensor?token=${SECRET}`);
    expect(verifyWebhookSecret(req(), url)).toBe(true);
  });

  it("rejects a wrong secret", async () => {
    const { verifyWebhookSecret } = await import("./webhook");
    expect(
      verifyWebhookSecret(req({ "x-alarm-secret": "wrong" }), new URL("http://localhost/x")),
    ).toBe(false);
  });

  it("rejects a missing secret", async () => {
    const { verifyWebhookSecret } = await import("./webhook");
    expect(verifyWebhookSecret(req(), new URL("http://localhost/x"))).toBe(false);
  });

  it("fails closed when no secret is configured on the server", async () => {
    delete process.env.WEBHOOK_SHARED_SECRET;
    const { verifyWebhookSecret } = await import("./webhook");
    expect(
      verifyWebhookSecret(req({ "x-alarm-secret": SECRET }), new URL("http://localhost/x")),
    ).toBe(false);
  });

  it("locks out a source after repeated wrong secrets, even once it sends the right one", async () => {
    const { verifyWebhookSecret } = await import("./webhook");
    const url = new URL("http://localhost/x");
    const attacker = req({ "x-alarm-secret": "wrong", "x-forwarded-for": "10.0.0.9" });
    for (let i = 0; i < 5; i++) {
      verifyWebhookSecret(attacker, url);
    }
    expect(
      verifyWebhookSecret(req({ "x-alarm-secret": SECRET, "x-forwarded-for": "10.0.0.9" }), url),
    ).toBe(false);
  });

  it("does not lock out a different source", async () => {
    const { verifyWebhookSecret } = await import("./webhook");
    const url = new URL("http://localhost/x");
    const attacker = req({ "x-alarm-secret": "wrong", "x-forwarded-for": "10.0.0.9" });
    for (let i = 0; i < 5; i++) {
      verifyWebhookSecret(attacker, url);
    }
    expect(
      verifyWebhookSecret(req({ "x-alarm-secret": SECRET, "x-forwarded-for": "10.0.0.1" }), url),
    ).toBe(true);
  });
});
