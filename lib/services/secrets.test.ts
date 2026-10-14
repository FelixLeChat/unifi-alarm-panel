import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, SecretsKeyError, secretsKeyStatus } from "./secrets";

const KEY_A = Buffer.alloc(32, 1).toString("base64");
const KEY_B = Buffer.alloc(32, 2).toString("base64");

const original = process.env.SECRETS_KEY;

beforeEach(() => {
  process.env.SECRETS_KEY = KEY_A;
});

afterEach(() => {
  if (original === undefined) delete process.env.SECRETS_KEY;
  else process.env.SECRETS_KEY = original;
});

describe("secrets", () => {
  it("round-trips a value and never stores the plaintext", () => {
    const stored = encryptSecret("slackBotToken", "xoxb-secret");
    expect(stored).not.toContain("xoxb-secret");
    expect(stored.startsWith("v1:")).toBe(true);
    expect(decryptSecret("slackBotToken", stored)).toBe("xoxb-secret");
  });

  it("uses a fresh IV, so the same value encrypts differently each time", () => {
    expect(encryptSecret("k", "same")).not.toBe(encryptSecret("k", "same"));
  });

  it("returns null with the wrong key instead of throwing", () => {
    const stored = encryptSecret("k", "value");
    process.env.SECRETS_KEY = KEY_B;
    expect(decryptSecret("k", stored)).toBeNull();
  });

  it("returns null when the ciphertext was tampered with", () => {
    const [v, iv, tag, ct] = encryptSecret("k", "value").split(":");
    const flipped = Buffer.from(ct, "base64");
    flipped[0] ^= 1;
    expect(decryptSecret("k", [v, iv, tag, flipped.toString("base64")].join(":"))).toBeNull();
  });

  it("binds the value to its setting name", () => {
    const stored = encryptSecret("protectApiKey", "value");
    expect(decryptSecret("slackBotToken", stored)).toBeNull();
  });

  it("refuses to encrypt without a valid key", () => {
    delete process.env.SECRETS_KEY;
    expect(secretsKeyStatus()).toBe("missing");
    expect(() => encryptSecret("k", "v")).toThrow(SecretsKeyError);
    process.env.SECRETS_KEY = Buffer.alloc(16).toString("base64");
    expect(secretsKeyStatus()).toBe("invalid");
    expect(() => encryptSecret("k", "v")).toThrow(SecretsKeyError);
  });
});
