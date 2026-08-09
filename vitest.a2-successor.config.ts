/**
 * Offline A2 successor carry-evidence audit.
 *
 * This config cannot discover the paid live runner. The selected audit also
 * requires exact local approval markers and refuses every provider/Supabase
 * credential, URL, and live A2 mode before reading ignored frozen evidence.
 */
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["tests/a2-successor-evidence.local.ts"],
    environment: "node",
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
