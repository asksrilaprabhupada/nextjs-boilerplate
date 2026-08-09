/**
 * vitest.config.ts — Unit test runner configuration
 *
 * Tests live in tests/ and exercise the pure lib functions (RRF fusion,
 * multi-query hardening, verbatim validation). The @/ alias matches
 * tsconfig's path mapping so lib modules import identically in tests.
 */
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
