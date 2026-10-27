#!/usr/bin/env node
import { configFromEnv } from "./config";
import { createServer } from "./server";

let config: ReturnType<typeof configFromEnv>;
try {
  config = configFromEnv(process.env);
} catch (error) {
  console.error(`towhee: ${(error as Error).message}`);
  process.exit(1);
}

const server = createServer(config.server);
const { url } = await server.listen(config.port, config.host);
console.log(`towhee: listening on ${url} (data: ${config.server.dataPath})`);

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  console.log(`towhee: ${signal}, saving rooms and shutting down`);
  await server.close();
  process.exit(0);
}
process.on("SIGTERM", () => void stop("SIGTERM"));
process.on("SIGINT", () => void stop("SIGINT"));
