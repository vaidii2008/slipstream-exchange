import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Creates and migrates slipstream_test before any test file runs.
    globalSetup: ["./testdb.ts"],
  },
});
