import pg from "pg";
import type { ProcessorConfig } from "./config.js";

const { Pool } = pg;

export type Database = pg.Pool;
export type DatabaseClient = pg.PoolClient;

export function createDatabase(config: ProcessorConfig): Database {
  const ssl = config.databaseSsl ? { rejectUnauthorized: false } : undefined;
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl,
  });
}

export async function checkDatabase(database: Database): Promise<void> {
  await database.query("SELECT 1");
}
