import { handleRequest } from "@towhee/cloudflare";
import { type DemoEnv, demoToken } from "./demo";

export { TowheeInbox, TowheeRoom } from "@towhee/cloudflare";

/**
 * towhee.madebytobi.com: the website (static assets, served before this code runs), the Towhee
 * server at /v1 and /health, and the demo's token endpoint.
 */
export default {
  fetch(request, env) {
    if (new URL(request.url).pathname === "/demo/token") return demoToken(request, env);
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<DemoEnv>;
