import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    include: ["src/**/*.test.ts"],
    // ts.Program creation in virtual-program fixtures parses the default libs
    // on first use; under CPU contention that cold start alone can exceed the
    // 5s default and flake. 20s keeps real hangs detectable.
    testTimeout: 20_000,
  },
});
