import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include:     ["backend/tests/**/*.test.ts"],
    environment: "node",
    globals:     true,
    // Provide a clean env for each test file
    setupFiles:  [],
  },
});
