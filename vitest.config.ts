import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // T-525: the continuity fixture is a whole app with its own node:test files;
    // they run inside the fixture (`npm test` there), never under this suite.
    exclude: ["**/node_modules/**", "test/fixtures/**"],
    setupFiles: ["test/setup.ts"],
    globalSetup: ["test/e2e-acceptance-probe.global.ts", "test/setup-review-supervisor.global.ts"],
  },
});
