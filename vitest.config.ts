import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    globalSetup: ["./test/global-home.ts"],
    setupFiles: ["./test/setup-home.ts"],
    teardownTimeout: 30_000,
    sequence: {
      hooks: "stack",
    },
  },
});
