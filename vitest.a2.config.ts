/**
 * Paid A2 comparison runner.
 *
 * Kept separate from ordinary Vitest discovery so `npm test` can never make
 * provider calls. The live file itself also requires an explicit approval
 * marker and complete server credentials before it begins.
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
    include: ["tests/a2-rerank-comparison.live.ts"],
    environment: "node",
    pool: "threads",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 28_800_000,
    hookTimeout: 60_000,
  },
});
