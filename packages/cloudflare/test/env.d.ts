import type { TowheeEnv } from "../src";

declare global {
  namespace Cloudflare {
    interface Env extends TowheeEnv {}
    // Types `exports` from "cloudflare:workers" as this Worker's main module.
    interface GlobalProps {
      mainModule: typeof import("./worker");
    }
  }
}
