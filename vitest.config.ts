import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    // Code that reaches getDb() without a test setting DATABASE_PATH must never write ./data/alarm.db.
    env: { DATABASE_PATH: ":memory:" },
    include: ["lib/**/*.test.ts", "app/**/*.test.ts", "test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
