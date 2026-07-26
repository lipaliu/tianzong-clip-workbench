import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

const config = loadConfig();
const database = createDatabase(config);
const app = await buildApp({ config, database });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.end();
  process.exit(0);
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: "0.0.0.0", port: config.port });
} catch (error) {
  app.log.fatal({ err: error }, "failed to start API");
  await database.end();
  process.exit(1);
}
