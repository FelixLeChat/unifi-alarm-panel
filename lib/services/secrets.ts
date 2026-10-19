import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * At-rest encryption for the credentials stored in the `settings` table
 * (Protect API key, SuperAdmin password, Slack tokens). A copied database
 * file or one of the nightly backups (lib/services/db-backup.ts) is useless
 * without SECRETS_KEY, which only lives in the environment.
 *
 * AES-256-GCM, a fresh 12-byte IV per value, and the setting's name as
 * associated data: a ciphertext moved to another row fails to decrypt
 * instead of quietly becoming that row's value.
 *
 * Stored as `v1:<iv>:<tag>:<ciphertext>`, each part base64.
 */

const VERSION = "v1";

export type SecretsKeyStatus = "ok" | "missing" | "invalid";

export class SecretsKeyError extends Error {
  constructor(status: Exclude<SecretsKeyStatus, "ok">) {
    super(
      status === "missing"
        ? "SECRETS_KEY is not set. Generate one with `openssl rand -base64 32` and restart."
        : "SECRETS_KEY must be 32 bytes, base64-encoded. Generate one with `openssl rand -base64 32`.",
    );
  }
}

function readKey(): { status: SecretsKeyStatus; key: Buffer | null } {
  const raw = process.env.SECRETS_KEY?.trim();
  if (!raw) return { status: "missing", key: null };
  const key = Buffer.from(raw, "base64");
  return key.length === 32 ? { status: "ok", key } : { status: "invalid", key: null };
}

export function secretsKeyStatus(): SecretsKeyStatus {
  return readKey().status;
}

export function encryptSecret(name: string, plaintext: string): string {
  const { status, key } = readKey();
  if (!key) throw new SecretsKeyError(status as Exclude<SecretsKeyStatus, "ok">);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(name));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(
    ":",
  );
}

/** Null when the key is missing, wrong, or the value was tampered with: the caller treats the secret as unset. */
export function decryptSecret(name: string, stored: string): string | null {
  const { key } = readKey();
  if (!key) return null;
  const [version, iv, tag, ciphertext] = stored.split(":");
  if (version !== VERSION || !iv || !tag || ciphertext === undefined) return null;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(name));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}
