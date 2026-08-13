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

const REQUIRED_SCHEMA_COLUMNS = [
  ["media_uploads", "upload_purpose"],
  ["processing_jobs", "subtitle_upload_id"],
  ["processing_jobs", "transcript_source"],
] as const;

export async function checkRequiredSchema(database: Database): Promise<void> {
  const result = await database.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (table_name, column_name) IN (
          ('media_uploads', 'upload_purpose'),
          ('processing_jobs', 'subtitle_upload_id'),
          ('processing_jobs', 'transcript_source')
        )`,
  );
  const present = new Set(
    result.rows.map((row) => `${row.table_name}.${row.column_name}`),
  );
  const missing = REQUIRED_SCHEMA_COLUMNS
    .map(([table, column]) => `${table}.${column}`)
    .filter((column) => !present.has(column));
  if (missing.length > 0) {
    throw new Error(`database schema migrations are missing: ${missing.join(", ")}`);
  }
}
