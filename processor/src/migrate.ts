import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { createDatabase } from "./db.js";

export async function runMigrations(options: {
  databaseUrl: string;
  nodeEnv: "development" | "test" | "production";
  migrationsDirectory: string;
}): Promise<void> {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: options.nodeEnv,
    DATABASE_URL: options.databaseUrl,
  });
  const database = createDatabase(config);
  const client = await database.connect();
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('tianclip-schema-migrations'))");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename text PRIMARY KEY,
         sha256 text NOT NULL,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const filenames = (await readdir(options.migrationsDirectory))
      .filter((name) => /^\d+.*\.sql$/.test(name))
      .sort();

    for (const filename of filenames) {
      const sql = await readFile(resolve(options.migrationsDirectory, filename), "utf8");
      const sha256 = createHash("sha256").update(sql).digest("hex");
      const existing = await client.query(
        "SELECT sha256 FROM schema_migrations WHERE filename = $1",
        [filename],
      );
      if (existing.rowCount) {
        if (existing.rows[0]?.sha256 !== sha256) {
          throw new Error(`Applied migration ${filename} has changed`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query(
          "INSERT INTO schema_migrations(filename, sha256) VALUES($1, $2)",
          [filename, sha256],
        );
        await client.query("COMMIT");
        process.stdout.write(`applied ${filename}\n`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext('tianclip-schema-migrations'))")
      .catch(() => undefined);
    client.release();
    await database.end();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const migrationsDirectory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../migrations",
  );
  await runMigrations({
    databaseUrl: config.databaseUrl,
    nodeEnv: config.nodeEnv,
    migrationsDirectory,
  });
}
