import { defineConfig } from "vitest/config";

// Node only: this package is the Node host.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000 },
});
