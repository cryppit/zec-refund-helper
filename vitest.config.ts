import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.live.test.ts", "**/node_modules/**"],
    testTimeout: 60_000,
  },
});
