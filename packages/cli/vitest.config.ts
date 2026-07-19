import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // Tests run the real analyzer pipeline (ts.Program creation) — the cold
    // start alone can exceed the 5s default under CPU contention.
    testTimeout: 20_000,
  },
});
