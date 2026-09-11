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

/** Trimmed string env var; blank/absent => fallback (usually ""). */
function str(name: string, fallback = ""): string {
  const v = process.env[name];
  const trimmed = typeof v === "string" ? v.trim() : "";
  return trimmed !== "" ? trimmed : fallback;
}

/** Boolean env var. Accepts 1/true/yes/on (and their negatives), else fallback. */
function bool(name: string, fallback: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "1" || s === "true" || s === "yes" || s === "on") return true;
  if (s === "0" || s === "false" || s === "no" || s === "off") return false;
  return fallback;
}

/**
 * Enum env var: whitelisted against a fixed set, case-insensitively. An unknown
 * value falls back rather than throwing — a typo in an env var must not stop the
 * app booting (§7.7) — but it says so, because silently ignoring a deliberate
 * setting is how a misconfiguration survives a deploy.
 */
function oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const s = v.trim().toLowerCase();
  const hit = allowed.find((a) => a === s);
  if (hit) return hit;
  console.error(`[config] ${name}="${s}" is not one of ${allowed.join("|")} — falling back to "${fallback}"`);
  return fallback;
}

/**
 * Fractional env var in (0, 1]. Used for the reconciliation safety ratio, where
 * a typo must never widen the guard: anything unreadable, non-finite, <= 0 or
 * > 1 falls back and says so rather than silently permitting a bigger purge.
 */
function ratio(name: string, fallback: number): number {
  const v = process.env[name];
  if (v === undefined || v.trim() === "") return fallback;
  const n = Number.parseFloat(v.trim());
  if (Number.isFinite(n) && n > 0 && n <= 1) return n;
  console.error(`[config] ${name}="${v.trim()}" is not a fraction in (0,1] — falling back to ${fallback}`);
  return fallback;
}

/** Comma-separated list env var; blank entries dropped, empty list => fallback. */
function csv(name: string, fallback: readonly string[]): readonly string[] {
  const v = process.env[name];
  if (v === undefined) return fallback;
  const parts = v.split(",").map((s) => s.trim()).filter((s) => s !== "");
  return parts.length > 0 ? parts : fallback;
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

  // ── Stock 2.0 / Selaras ERP mirror (CONTRACTS §3) ──────────────────────────
  /**
   * ERP REST mirror base URL. **Empty => ERP disabled** (`hasErp === false`).
   *
   * Verified 2026-09-11: `https://selaras2.io/kencana/api`. The `/api` suffix
   * belongs in this variable; rows come from `<base>/table/{table}`, the table
   * list from `<base>/tables` and a schema from `<base>/table/{table}/columns`.
   *
   * NOT `https://selaras2.io/kencana/table_documentation` — that is the
   * human-facing documentation SPA, not the API root, and it is the obvious
   * wrong turn. A trailing slash either way is fine (buildPageUrl strips them).
   */
  selarasBaseUrl: str("SELARAS_BASE_URL"),
  /**
   * Bearer token for the ERP mirror. SECRET: never log it, never echo it into a
   * response or an error message (CONTRACTS §7.9).
   *
   * Used only when `selarasAuthMode` is `bearer`. Selaras itself authenticates
   * with a KEY + TOKEN pair (below), not a single bearer credential.
   */
  selarasToken: str("SELARAS_TOKEN"),
  /**
   * Selaras issues two credentials — a `secret_key` and a `secret_token` — so a
   * single `Authorization: Bearer` cannot authenticate against it at all.
   *
   * Verified 2026-09-11: they travel as the headers `X-Secret-Key` and
   * `X-Secret-Token` (preferred), or as the query params `?secret_key=` /
   * `?secret_token=`. Both placements stay supported behind one env var.
   *
   * SECRET, both of them: never logged, never echoed into a response (§7.9).
   */
  selarasSecretKey: str("SELARAS_SECRET_KEY"),
  selarasSecretToken: str("SELARAS_SECRET_TOKEN"),
  /** `header` (default, and what the API documents) · `query` · `bearer` (legacy). */
  selarasAuthMode: oneOf("SELARAS_AUTH_MODE", ["header", "query", "bearer"] as const, "header"),
  /**
   * The credential names, which are NOT the same in the two placements —
   * verified 2026-09-11. Headers are `X-Secret-Key` / `X-Secret-Token`; query
   * params are `secret_key` / `secret_token`. Each mode therefore carries its
   * own default instead of one name being lower-cased into the other's slot,
   * which is how the header mode came to send `secret_key:` and fail 401.
   *
   * Both remain configurable, and all four names are in the redaction set.
   */
  selarasKeyHeader: str("SELARAS_KEY_HEADER", "x-secret-key"),
  selarasTokenHeader: str("SELARAS_TOKEN_HEADER", "x-secret-token"),
  selarasKeyParam: str("SELARAS_KEY_PARAM", "secret_key"),
  selarasTokenParam: str("SELARAS_TOKEN_PARAM", "secret_token"),
  /** Per-request timeout against the ERP mirror. */
  selarasTimeoutMs: int("SELARAS_TIMEOUT_MS", 20_000),
  /**
   * How to read a numeric value that arrives as a STRING (A22). JSON numbers are
   * never affected — they are unambiguous and pass through untouched.
   *
   * `"1.234"` means 1234 in Indonesian notation and 1.234 in English notation,
   * and this company's stock data is documented as id-locale (`num()` in
   * `routes/stock.ts`, PRD §8.4; a real bug, fixed in fc4ab5a). But `"0.350"` is
   * a genuine thickness of 0.35 that the id rule would read as 350. No parser is
   * correct without knowing the emitter, so:
   *
   *   auto — refuse an ambiguous string LOUDLY (null / 0, counted and logged)
   *          rather than guess. A refused quantity reserves nothing; a guessed
   *          one can be wrong by a factor of 1000, silently.
   *   id   — dot = thousands, comma = decimal, last separator wins.
   *   en   — comma = thousands, dot = decimal.
   *
   * Set this to `id` or `en` once a real Selaras response body has been seen.
   */
  selarasNumberFormat: oneOf("SELARAS_NUMBER_FORMAT", ["auto", "id", "en"] as const, "auto"),
  /**
   * Stock 2.0 tunables. Nested because the views in migrateErpStock.ts read
   * `config.stock.*` by name (CONTRACTS §2.3).
   */
  stock: {
    /** Sync cadence — 3 min, inside PRD §4's 2–5 min band (ST-R6). */
    syncIntervalMs: int("STOCK_SYNC_INTERVAL_MS", 180_000),
    /** `limit` query param per page of the mirror pull. */
    syncPageSize: int("STOCK_SYNC_PAGE_SIZE", 1_000),
    /**
     * Safety lookback subtracted from the stored cursor on every incremental
     * request. 12 hours by default, and the size is the point: it must
     * comfortably exceed the SEVEN-hour WIB offset.
     *
     * The failure it absorbs: the verified documentation spells datetimes as
     * `YYYY-MM-DD HH:mm:ss` in WIB (UTC+7) and says nothing about ISO-8601. If
     * the ERP were to parse an offset-bearing cursor and then DISCARD the
     * offset, our cursor would land seven hours ahead of where it belongs,
     * every row updated in that window would be skipped, and — because a cursor
     * only moves forward — no later run would ever revisit them. Nothing logs;
     * ATP is simply, quietly wrong for those SKUs. We now send the documented
     * WIB grammar, and this lookback means even a whole misread timezone cannot
     * lose a row.
     *
     * It costs nothing: every write is an idempotent upsert keyed on the ERP's
     * primary key, which is exactly the property that makes re-fetching free.
     */
    syncLookbackMinutes: int("STOCK_SYNC_LOOKBACK_MINUTES", 720),
    /** ST-R17 liveness window: an SO line older than this is stale, not live. */
    staleWindowDays: int("STOCK_STALE_WINDOW_DAYS", 60),
    /** status_order values that mean "this line is dead" (OQ-1, tune at validation). */
    cancelledStatuses: csv("STOCK_CANCELLED_STATUSES", ["Cancelled", "Void", "Batal"]),
    /**
     * ST-R7b / OQ-1: the `approval` values that mean "this line commits stock".
     * Config, never a literal — and the ASYMMETRIC one of the two status sets.
     *
     * An unmatched CANCELLED value fails safe: a cancelled line keeps reserving,
     * so ATP is understated and someone complains. An unmatched APPROVED value
     * fails CATASTROPHICALLY: `v_live_commitments` returns zero rows, every SKU's
     * open_commitment is 0, ATP collapses to on-hand, and the entire inventory
     * reads as promiseable — a page that looks healthier than normal, so nobody
     * complains. Nobody in this repo has seen a real Selaras response (HANDOVER
     * §2), so `APPROVED` / `Approve` / `1` / `Y` are all live possibilities.
     *
     * Hence the boot/first-sync sanity check in migrateErpStock.checkCommitmentGate():
     * lines mirrored but no live commitments ⇒ one loud warn naming this variable.
     */
    approvedStatuses: csv("STOCK_APPROVED_STATUSES", ["Approved"]),
    /**
     * ST-R22 auto-close: `status_order` values that mean "the goods went out and
     * the ERP simply never zeroed the balance". Config, so adding `Done` later is
     * an env change rather than a code change.
     *
     * SAFE WHEN EMPTY, exactly like the cancelled set and unlike the approved
     * one: a set that validates down to nothing auto-closes nothing, and every
     * line stays in the review queue where a human decides. Nothing is released.
     */
    autocloseStatuses: csv("STOCK_AUTOCLOSE_STATUSES", ["DO"]),
    /**
     * ST-R22 auto-close age, measured on `estimate_delivery` and on NOTHING ELSE
     * (product-owner ruling, 2026-09-11). A delivery order whose delivery date is
     * more than half a year old has, in practice, shipped.
     *
     * Keep this ABOVE `staleWindowDays`. That ordering is what makes auto-close a
     * zero-ATP operation: a line this old already failed the liveness window, so
     * it was already excluded from `open_commitment` and closing it moves no
     * stock. Set below the window and auto-close starts releasing LIVE
     * reservations — stock already owed to a customer. migrateErpStock warns
     * loudly at boot if the two are configured that way round.
     */
    autocloseAfterDays: int("STOCK_AUTOCLOSE_AFTER_DAYS", 180),
    /**
     * Full-key reconciliation cadence. An incremental `updated_at__gte` pull can
     * structurally never observe a DELETE (PRD §10), so a separate, slower sweep
     * compares the ERP's full key set against the mirror and purges what is gone.
     * Hourly by default — not on every 3-minute poll.
     */
    reconcileIntervalMs: int("STOCK_RECONCILE_INTERVAL_MS", 3_600_000),
    /**
     * Safety floor for that sweep: if the ERP hands back fewer than this fraction
     * of the keys we already mirror, ABORT rather than purge. A truncating bug
     * upstream must never empty our mirror.
     */
    reconcileMinRatio: ratio("STOCK_RECONCILE_MIN_RATIO", 0.5),
    /** ST-R7: no successful sync in N intervals => the stale banner lights up. */
    syncStaleAlertIntervals: int("STOCK_SYNC_STALE_ALERT_INTERVALS", 4),
    /** ST-R16 shadow mode: compute ATP but keep 1.0 numbers authoritative. */
    atpShadow: bool("STOCK_ATP_SHADOW", false),
    /**
     * ST-R5.2 knob: the canonical SKU key composition. See erp/sku.ts.
     *
     * v2 (2026-09-11): the verified `tbl_1203` column list has no `kode_barang`
     * and no `th`, so the v1 key could never have matched. `th` here is the
     * ALUMINIUM SKIN (SO `th_alu_skin` / FG `th`) and `th_panel` the total panel
     * (SO `total_thickness_acp` / FG `t`).
     */
    skuKeySegments: csv("STOCK_SKU_KEY_SEGMENTS", ["brand", "warna", "th", "th_panel", "p", "l"]),
    /**
     * ST-R5.2 safety net. The v2 key composition is verified against the ERP's
     * documented COLUMNS but has never been run against real ROWS, so after each
     * sync the worker measures what fraction of live commitments found no stock
     * row with the same `sku_key`. Above this fraction it logs one loud error.
     *
     * It matters because the failure is silent and one-directional: unmatched
     * demand means `open_commitment` is 0, ATP equals on-hand and the inventory
     * reads as fully promiseable — a page that looks healthier than the truth.
     */
    unmatchedAlertRatio: ratio("STOCK_UNMATCHED_ALERT_RATIO", 0.5),
    /**
     * ST-R5.3 column diagnostic. Default ON, because the question it answers is
     * currently open: production reports 97.4% of live commitment lines matching
     * NO stock row, with every demand key ending `|-|-` (no `p`/`l` on the SO
     * side) and every stock key carrying `|0|0|` in the two thickness positions.
     * Each side is missing precisely the segments the other side has, which is a
     * column-mapping failure and not dirty data.
     *
     * Three explanations fit that evidence and only real traffic separates them:
     * the API returns different NAMES than the documentation lists, it returns
     * them NESTED, or it returns NULL for these rows. Guessing between them is
     * what produced the v1 key that matched nothing, so instead the sync prints,
     * once per table per run, the raw wire key names of the first row and the
     * per-segment probe result — see `buildColumnDiagnostic()` in
     * erp/selarasClient.ts.
     *
     * Turn it OFF once the mapping is settled; it is pure observation and
     * changes no sync behaviour either way.
     */
    diagnoseColumns: bool("STOCK_SYNC_DIAGNOSE_COLUMNS", true),
  },
} as const;

export const hasDatabase = Boolean(config.databaseUrl);
/** ERP disabled when no base URL: every surface degrades, nothing throws (§7.7). */
export const hasErp = Boolean(config.selarasBaseUrl);
/**
 * True when a credential is actually present for the configured mode. The base
 * URL alone enables the module; this says whether a request can be authorized.
 * Kept separate so an unauthenticated misconfiguration is a loud 401 in the sync
 * log rather than a silently disabled integration.
 */
export const hasErpCredentials =
  config.selarasAuthMode === "bearer"
    ? Boolean(config.selarasToken)
    : Boolean(config.selarasSecretKey && config.selarasSecretToken);

