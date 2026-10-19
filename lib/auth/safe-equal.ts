import { timingSafeEqual } from "node:crypto";

/** A secret from the environment counts as configured only when it is not the .env.example placeholder and is long enough to not be guessed on a LAN. */
export function isUsableSecret(value: string | undefined): value is string {
  return !!value && value !== "change-me" && value.length >= 12;
}

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
