import { config } from "dotenv";

config({ path: "../../.env" });
config();

import { buildApp } from "./app.js";
import { loadEnv } from "./config/env.js";

const env = loadEnv();
const app = await buildApp();

let isShuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  app.log.info({ signal }, "received shutdown signal");

  try {
    await app.close();
    process.exit(0);
  } catch (error) {
    app.log.error({ error, signal }, "failed to close app during shutdown");
    process.exit(1);
  }
}

process.once("SIGINT", (signal) => {
  void shutdown(signal);
});
process.once("SIGTERM", (signal) => {
  void shutdown(signal);
});

await app.listen({
  port: env.PORT,
  host: env.HOST
});
