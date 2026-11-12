/**
 * Suites that change `notify_settings` (the live mode, the kill switch, the
 * per-step switches) take this lock for their whole run, so they never flip a
 * switch under another suite's feet. Session-level advisory lock on its own
 * connection: held until release(), invisible to everything else.
 */
import postgres from "postgres";

const KEY = 4_242_001;

export async function lockNotifySettings(): Promise<() => Promise<void>> {
  const url = process.env.DATABASE_URL;
  if (!url) return async () => undefined;
  const conn = postgres(url, { max: 1, onnotice: () => undefined });
  await conn`select pg_advisory_lock(${KEY})`;
  return async () => {
    await conn`select pg_advisory_unlock(${KEY})`.catch(() => undefined);
    await conn.end({ timeout: 5 });
  };
}
