/**
 * Offline A2 frozen-evidence audit.
 *
 * This config cannot discover the paid live runner. The selected test also
 * requires an exact local marker and refuses every provider/Supabase key, URL,
 * and live A2 mode before reading ignored historical evidence.
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
    include: ["tests/a2-carry-evidence.local.ts"],
    environment: "node",
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
  },
});
