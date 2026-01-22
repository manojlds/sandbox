import { defineConfig } from "vitest/config";

// In CI environments, skip integration tests that require Pyodide network access
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120000, // 2 minutes for integration tests (Pyodide init is slow)
    hookTimeout: 30000,
    teardownTimeout: 10000,
    include: ["test/**/*.test.ts"],
    exclude: isCI ? ["test/integration.test.ts"] : [],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/integration.test.ts"],
    },
  },
});
