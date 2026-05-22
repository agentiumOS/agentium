import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["packages/*/src/**/*.test.ts"],
    testTimeout: 15_000,
    pool: "forks",
  },
});
