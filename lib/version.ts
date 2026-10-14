import { readFileSync } from "node:fs";
import { join } from "node:path";

let cached: string | undefined;

// deploy/build.sh writes a VERSION file (git describe) into .next/standalone/
// alongside server.js; falls back to "dev" for `pnpm dev`, where it doesn't exist.
export function getAppVersion(): string {
  if (cached === undefined) {
    try {
      cached = readFileSync(join(process.cwd(), "VERSION"), "utf8").trim();
    } catch {
      cached = "dev";
    }
  }
  return cached;
}
