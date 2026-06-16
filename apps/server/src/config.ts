/**
 * Centralized, env-driven configuration. All edges read from here so the
 * scraper tunables (microPRD §10) live in one place.
 */
import { existsSync, readFileSync } from "node:fs";

/**
 * Minimal dev-only .env loader (no dependency). Production gets real env vars
 * from Railway, so we only read a local .env when one exists and a key isn't
 * already set. Lines are `KEY=VALUE`; `#` comments and blanks are ignored.
 */
function loadDotEnv(): void {
  if (process.env.NODE_ENV === "production") return;
  if (!existsSync(".env")) return;
  for (const line of readFileSync(".env", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const config = {
  port: int("PORT", 8080),
  host: "0.0.0.0",
  /** Scraper concurrency (sites in flight). */
  concurrency: int("CONCURRENCY", 10),
  /** Per-request fetch timeout. */
  requestTimeoutMs: int("REQUEST_TIMEOUT_MS", 12_000),
  /** Homepage + (N-1) discovered pages. */
  maxPagesPerSite: int("MAX_PAGES_PER_SITE", 4),
  /** Postgres connection string (Part B). Absent => DB features degrade. */
  databaseUrl: process.env.DATABASE_URL ?? "",
  /** Upload size cap for the scraper (bytes). */
  maxUploadBytes: int("MAX_UPLOAD_BYTES", 15 * 1024 * 1024),
} as const;

export const hasDatabase = Boolean(config.databaseUrl);
