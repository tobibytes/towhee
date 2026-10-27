import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs in workerd with the real Worker and Durable Object from wrangler.test.jsonc.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
  test: { include: ["test/**/*.test.ts"], testTimeout: 15_000 },
});
