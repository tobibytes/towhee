import { defineConfig } from "vitest/config";

// Hooks render in jsdom against real @towhee/core rooms behind the client tests' fake network.
export default defineConfig({
  test: { environment: "jsdom", include: ["test/**/*.test.tsx"] },
});
