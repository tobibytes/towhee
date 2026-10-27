import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// The same tests run in Node and in workerd (the Cloudflare Workers runtime), without nodejs_compat,
// which also proves this package only uses web-standard APIs.
export default defineConfig({
  test: {
    projects: [
      { test: { name: "node", include: ["test/**/*.test.ts"] } },
      {
        plugins: [cloudflareTest({ miniflare: { compatibilityDate: "2026-10-01" } })],
        test: { name: "workerd", include: ["test/**/*.test.ts"] },
      },
    ],
  },
});
