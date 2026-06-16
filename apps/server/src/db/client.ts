/**
 * Postgres connection (microPRD §4, Part B). Thin singleton over porsager's
 * `postgres` driver, chosen for being light and fast to ship.
 *
 * The whole app must still boot and serve Part A when DATABASE_URL is absent,
 * so this returns `null` rather than throwing — callers degrade gracefully.
 */
import postgres from "postgres";
import { config, hasDatabase } from "../config.js";

export type Sql = postgres.Sql<{}>;

let sql: Sql | null = null;

export function getSql(): Sql | null {
  if (!hasDatabase) return null;
  if (!sql) {
    sql = postgres(config.databaseUrl, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      // Respect sslmode from the connection string; Railway's internal URL
      // needs no SSL, the public proxy URL carries ?sslmode=require.
      onnotice: () => {},
    });
  }
  return sql;
}

/** True when a usable connection can be established (used by /health + boot). */
export async function pingDatabase(): Promise<boolean> {
  const db = getSql();
  if (!db) return false;
  try {
    await db`select 1`;
    return true;
  } catch {
    return false;
  }
}

export async function closeDatabase(): Promise<void> {
  if (sql) {
    await sql.end({ timeout: 5 });
    sql = null;
  }
}
