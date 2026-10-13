import { defineConfig } from "vitest/config";

/** Live tests hit real public endpoints; run on demand with `pnpm test:live`. */
export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    testTimeout: 60_000,
  },
});
