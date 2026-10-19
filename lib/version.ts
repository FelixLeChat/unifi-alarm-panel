import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "@/lib/logger";

let cached: string | undefined;

// deploy/build.sh writes a VERSION file (git describe) into .next/standalone/
// alongside server.js; falls back to "dev" for `pnpm dev`, where it doesn't exist.
export function getAppVersion(): string {
  if (cached === undefined) {
    try {
      cached = readFileSync(join(process.cwd(), "VERSION"), "utf8").trim();
    } catch (err) {
      // No file is the dev case. Anything else (permissions, a broken deploy) must not pass as a dev build silently.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") logger.warn({ err }, "could not read VERSION, reporting dev");
      cached = "dev";
    }
  }
  return cached;
}
