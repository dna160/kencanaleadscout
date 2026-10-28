/**
 * ERP SCHEMA DISCOVERY PROBE — a diagnostic, not a feature.
 *
 * WHAT IT IS FOR
 *
 * `docs/produksi-1.0/BLUEPRINT-DRAFT.md` §0 is blocked on four facts about two
 * ERP tables nobody here has ever seen: their exact names, their columns, the
 * key that joins them, and whether raw-material movement exists in the ERP at
 * all. The dashboard cannot be designed without them, and the one thing that
 * must not happen is designing it against guesses — that has already cost this
 * project two cycles (`kode_barang` 42703 on every page; a SKU key that could
 * never match, both from assuming a plausible column existed).
 *
 * THE CHANNEL, AND WHY IT IS THE LOG
 *
 * `selaras2.io` is refused by every development environment we have (403 at
 * CONNECT from the egress proxy, verified 2026-10-26), and the Railway app
 * domain is unreachable from here too — so no interactive endpoint, however
 * convenient, can be called from where the question is being asked. Production
 * reaches the ERP. Railway's logs are readable from outside. The logs are
 * therefore the ONLY channel the ERP's real shape can come back through, and
 * this module is the thing that puts it there.
 *
 * WHAT IT DOES, ONCE
 *
 *   1. `GET <base>/tables` — the COMPLETE list, logged in chunks, unfiltered.
 *      The Work Order table's name is genuinely unknown and the owner's words
 *      ("request produksi", "work order") need not match the ERP's naming, so a
 *      name discarded here is a name nobody can ask about later.
 *   2. For the five tables the PRD already names, plus every name that
 *      plausibly relates to production / work orders / material / BOM /
 *      warehouse movement: `GET <base>/table/{name}/columns`.
 *   3. For each of those: ONE row, and from it the KEY NAMES only — plus the
 *      values of date- and status-shaped keys, because those decide the
 *      date basis (§2.4) and the stage model (§0.4) and nothing else can.
 *   4. A terminal marker, so a reader knows the output is complete rather than
 *      truncated mid-stream.
 *
 * WHAT IT CANNOT DO
 *
 *   · WRITE. This module imports no database client and issues no non-GET
 *     request: `fetchErpJson()` is GET-only by construction. There is no code
 *     path from here to any `insert`, `update`, `delete`, cursor or mirror
 *     table. `schemaProbe.test.ts` asserts that over the source text, because
 *     "read-only" is a property worth proving rather than promising.
 *   · RUN BESIDE A SYNC. The ERP's rate limiter is shared and this project has
 *     already had one production 429 loop (`docs/stock-2.0/HANDOVER.md`). The
 *     probe waits for `isErpSyncRunning()` to go false, re-checks before every
 *     single request, and SKIPS ENTIRELY rather than compete. One wasted deploy
 *     is far cheaper than a second rate-limit incident.
 *   · CRASH THE SERVER, or delay its boot. It is armed on an unref'd timer after
 *     `app.listen()`, every step resolves rather than throws, and the whole run
 *     is wrapped: a 404 on one table, a 429, or a total ERP outage logs the
 *     reason with the table name and the status code and moves on.
 *   · LEAK A CREDENTIAL. Every line goes through `redactSecrets()` at the one
 *     logger below, URLs are never logged, and values are rendered by
 *     `sampleValue()` — which gives a container's SHAPE and child key names and
 *     never its contents (§7.9).
 *
 * WHY "nothing printed" is never an acceptable outcome: it is indistinguishable
 * from "the table does not exist", and that ambiguity costs another deploy
 * cycle. Every failure here is logged with the table name and the status code.
 */
import type { Dispatcher } from "undici";
import { config, hasErp, hasErpCredentials } from "../config.js";
import {
  buildErpPathUrl,
  buildRowKeyDiagnostic,
  fetchErpJson,
  readEnvelope,
  redactSecrets,
  SELARAS_ENDPOINTS,
  type ErpJsonResult,
  type NotableKey,
  type RowKeyDiagnostic,
  type SelarasFailureKind,
} from "./selarasClient.js";
import { isErpSyncRunning } from "./syncWorker.js";

// ── Logging ──────────────────────────────────────────────────────────────────

export interface SchemaProbeLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Redaction is applied HERE, centrally, exactly as `defaultSyncLogger` does it —
 * one forgotten interpolation at a call site would otherwise be a token leak,
 * and this module writes a great many more lines than the sync does.
 */
export const defaultProbeLogger: SchemaProbeLogger = {
  info: (m) => console.info(`[erp-probe] ${redactSecrets(m)}`),
  warn: (m) => console.warn(`[erp-probe] ${redactSecrets(m)}`),
  error: (m) => console.error(`[erp-probe] ${redactSecrets(m)}`),
};

// ── The tables the PRD already names ─────────────────────────────────────────

/**
 * Probed BY NAME, unconditionally, whatever the name heuristic below thinks.
 *
 * These come out of `docs/stock-2.0/PRD.md`, which cites them directly. Making
 * their discovery conditional on a name-matching heuristic would be a pointless
 * risk: we are not guessing at these, we are confirming them. If one 404s, THAT
 * IS A FINDING — a renamed or unexposed table is worth its own line, and is the
 * difference between "the probe missed it" and "the ERP does not have it".
 */
interface SeedTable {
  /** The ERP name, or — when the PRD cites only the number — a `tbl_NNNN` prefix. */
  name: string;
  /** Why a human should care about this one, in the log, beside its columns. */
  why: string;
}

const SEED_TABLES: readonly SeedTable[] = [
  {
    name: "tbl_1236_DBRequestProduksiID",
    why: "REQUEST PRODUKSI — one of the two tables the owner named (BLUEPRINT-DRAFT §0.1); PRD §9 and §6 cite this exact name",
  },
  {
    name: "tbl_1179_STMutasiFGMX",
    why: "FG MUTATIONS — actual finished-goods stock movements (PRD ST-R13, ST-R22). The likeliest 'movement' half of the owner's 'raw material to finished goods', and the table §0.5 turns on",
  },
  {
    name: "tbl_1324_DBStockOpnameFG",
    why: "STOCK OPNAME / physical count (PRD ST-R12) — the reconciliation counterpart to on-hand",
  },
  {
    name: "tbl_1328",
    why: "INTERNAL TRANSFERS (PRD OQ-3) — the PRD cites the NUMBER ONLY, so this is a prefix and is resolved against the /tables listing",
  },
  {
    name: "tbl_1235",
    why: "SAMPLES / SPB (PRD OQ-3) — NUMBER ONLY in the PRD; resolved against the /tables listing",
  },
];

/**
 * The movement table gets a slightly larger sample than everything else.
 *
 * It is the one most likely to carry an in/out direction marker, and ONE row
 * shows ONE value of it — which cannot tell an enum from a constant. Whether
 * "movement" is derivable at all (§0.5) turns on exactly that distinction, so
 * this table is sampled a handful of rows deep and the DISTINCT values of its
 * direction- and status-shaped keys are reported. It is still one request.
 */
const MOVEMENT_TABLE = "tbl_1179_STMutasiFGMX";

/** A `tbl_NNNN` with no name after it — a prefix to resolve, not a table to GET. */
const PREFIX_ONLY_RE = /^tbl_\d+$/i;

// ── Which names are worth a schema request ───────────────────────────────────
//
// LOOSE AND GENEROUS, deliberately. Over-fetching a few extra schemas costs a
// second of pacing each; missing the one table that holds raw-material movement
// is the entire problem this probe exists to solve. The cap
// (ERP_SCHEMA_PROBE_MAX_TABLES) is the backstop against an absurdly wide ERP,
// and anything the cap trims is NAMED in the log rather than dropped silently.

/** Matched as a substring of the folded name. Indonesian and English both. */
const NAME_KEYWORDS: readonly string[] = [
  // production
  "produksi", "production", "produk", "manufact", "pabrik", "plant", "proses", "process",
  // work orders and the words an ERP uses for them
  "workorder", "work", "order", "perintah", "kerja", "spk", "job",
  // movement, in both directions
  "mutasi", "mutation", "movement", "trans", "issue", "keluar", "masuk", "terima",
  "receipt", "receive", "kirim", "surat", "adjust",
  // material and its recipes
  "material", "bahan", "baku", "rawmat", "bom", "resep", "formula", "recipe",
  "komponen", "component",
  // warehouse and stock
  "warehouse", "gudang", "stock", "stok", "opname", "inventor", "persediaan", "saldo",
  // work in progress and consumption
  "wip", "assembl", "konsumsi", "consumption", "usage", "pakai",
  // planning
  "batch", "lot", "jadwal", "schedule", "ppic", "mesin", "machine",
  // the documents this plant actually moves goods with
  "spb", "sample", "sampel", "request", "demand",
  // this company's own process steps
  "coil", "slit", "coating", "paint", "oven", "press", "laminat", "panel", "acp",
  // outputs
  "hasil", "output", "finish",
];

/**
 * Matched as a WHOLE TOKEN rather than a substring, because two letters inside
 * a word mean nothing: `wo` as a substring matches "Wood" and "Password".
 */
const NAME_TOKENS: readonly string[] = ["wo", "rm", "fg", "do", "bb", "pr", "po", "mo"];

/** `tbl_1179_STMutasiFGMX` → `tbl1179stmutasifgmx`. */
function foldTableName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * `tbl_1179_STMutasiFGMX` → ["tbl","1179","st","mutasi","fgmx"]. Underscores and
 * camelCase boundaries both, so a short token can be matched for what it is.
 */
function nameTokens(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter((t) => t !== "")
    .map((t) => t.toLowerCase());
}

/** The keyword that made a name interesting, or null. Reported, so WHY is visible. */
export function relevanceReason(name: string): string | null {
  const folded = foldTableName(name);
  for (const kw of NAME_KEYWORDS) {
    if (folded.includes(kw)) return `name contains '${kw}'`;
  }
  const tokens = new Set(nameTokens(name));
  for (const tok of NAME_TOKENS) {
    if (tokens.has(tok)) return `name has the token '${tok}'`;
  }
  return null;
}

/** The four tables the sync already mirrors — their columns are settled. */
const MIRRORED = new Set<string>(Object.values(SELARAS_ENDPOINTS));

// ── Reading two endpoints nobody here has ever called ────────────────────────

/** Names the ERP might use for a table name inside a `/tables` row. */
const TABLE_NAME_KEYS = ["table", "table_name", "tableName", "name", "tablename", "TABLE_NAME", "nama"];
/** …and for a column name / its type inside a `/columns` row. */
const COLUMN_NAME_KEYS = ["column", "column_name", "columnName", "name", "field", "Field", "COLUMN_NAME", "nama", "kolom"];
const COLUMN_TYPE_KEYS = ["data_type", "dataType", "type", "column_type", "columnType", "Type", "DATA_TYPE", "tipe"];
const COLUMN_EXTRA_KEYS = ["is_nullable", "nullable", "Null", "key", "Key", "column_key", "default", "Default", "extra", "Extra", "comment"];

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** First present, non-empty, scalar value under any of `keys` — casing-tolerant. */
function pickText(rec: Record<string, unknown>, keys: readonly string[]): string | null {
  const folded = new Map<string, unknown>();
  for (const [k, v] of Object.entries(rec)) {
    const f = foldTableName(k);
    if (!folded.has(f)) folded.set(f, v);
  }
  for (const key of keys) {
    const v = folded.get(foldTableName(key));
    if (typeof v === "string" && v.trim() !== "") return v.trim();
    if (typeof v === "number" || typeof v === "boolean") return String(v);
  }
  return null;
}

/** A row of `/tables` or `/columns` that we could not name. Its KEYS are the finding. */
function unreadableShape(entry: unknown): string {
  if (isRecord(entry)) return `{${Object.keys(entry).sort().slice(0, 12).join(",")}}`;
  if (Array.isArray(entry)) return `<array of ${entry.length}>`;
  return `<${typeof entry}>`;
}

export interface TableListReading {
  names: readonly string[];
  /** What `readEnvelope()` saw, verbatim — this endpoint's shape is unverified. */
  shape: string;
  /** Entries whose table name could not be read, by their own key shape. */
  unreadable: readonly string[];
}

/**
 * `GET <base>/tables`, read defensively. NEVER throws.
 *
 * The response shape is UNVERIFIED — this endpoint is named in the client's
 * header and has never once been called — so every plausible form is accepted
 * and the form actually observed is reported: a row array under any of the
 * tolerated keys, entries that are plain strings, entries that are objects with
 * a name field, a MySQL-style `{Tables_in_kencana: "..."}` single-field row, or
 * a top-level object keyed BY table name.
 */
export function readTableList(body: unknown, limit: number): TableListReading {
  const env = readEnvelope(body, limit);
  const names: string[] = [];
  const unreadable: string[] = [];
  for (const entry of env.rows) {
    if (typeof entry === "string") {
      if (entry.trim() !== "") names.push(entry.trim());
      continue;
    }
    if (isRecord(entry)) {
      const named = pickText(entry, TABLE_NAME_KEYS);
      if (named !== null) {
        names.push(named);
        continue;
      }
      // `{Tables_in_kencana: "tbl_1179_..."}` — one field, and it is the name.
      const vals = Object.values(entry);
      if (vals.length === 1 && typeof vals[0] === "string" && vals[0].trim() !== "") {
        names.push(vals[0].trim());
        continue;
      }
    }
    unreadable.push(unreadableShape(entry));
  }

  // `{ "tbl_1179_STMutasiFGMX": {...}, ... }` — an object keyed by table name,
  // with no row array anywhere. Accepted only when the keys really look like
  // this ERP's table names, so envelope metadata is never mistaken for data.
  if (names.length === 0 && isRecord(body)) {
    const keys = Object.keys(body);
    if (keys.some((k) => /^tbl_\d/i.test(k))) {
      return {
        names: keys,
        shape: `${env.shape}; FELL BACK to the top-level object's own KEYS as table names (${keys.length} of them)`,
        unreadable: [],
      };
    }
  }

  return { names, shape: env.shape, unreadable };
}

export interface ErpColumn {
  name: string;
  /** The declared type, when the endpoint gives one. Null when it does not. */
  type: string | null;
  /** Nullability / key / default, when given — folded into one short string. */
  extra: string | null;
}

export interface ColumnListReading {
  columns: readonly ErpColumn[];
  shape: string;
  unreadable: readonly string[];
}

/** `GET <base>/table/{name}/columns`, read with the same tolerance. NEVER throws. */
export function readColumnList(body: unknown, limit: number): ColumnListReading {
  const env = readEnvelope(body, limit);
  const columns: ErpColumn[] = [];
  const unreadable: string[] = [];
  for (const entry of env.rows) {
    if (typeof entry === "string") {
      if (entry.trim() !== "") columns.push({ name: entry.trim(), type: null, extra: null });
      continue;
    }
    if (isRecord(entry)) {
      const name = pickText(entry, COLUMN_NAME_KEYS);
      if (name !== null) {
        const extras: string[] = [];
        for (const key of COLUMN_EXTRA_KEYS) {
          const v = pickText(entry, [key]);
          if (v !== null) extras.push(`${key}=${v}`);
        }
        columns.push({
          name,
          type: pickText(entry, COLUMN_TYPE_KEYS),
          extra: extras.length > 0 ? extras.join(" ") : null,
        });
        continue;
      }
    }
    unreadable.push(unreadableShape(entry));
  }

  // `{ "kode_barang": "varchar(32)", ... }` — a column→type map rather than rows.
  if (columns.length === 0 && isRecord(body)) {
    const scalarEntries = Object.entries(body).filter(
      ([, v]) => typeof v === "string" || typeof v === "number" || isRecord(v),
    );
    if (scalarEntries.length > 1 && !("success" in body) && !("meta" in body) && !("data" in body)) {
      return {
        columns: scalarEntries.map(([k, v]) => ({
          name: k,
          type: typeof v === "string" ? v : isRecord(v) ? (pickText(v, COLUMN_TYPE_KEYS) ?? null) : String(v),
          extra: null,
        })),
        shape: `${env.shape}; FELL BACK to the top-level object as a column→type map`,
        unreadable: [],
      };
    }
  }

  return { columns, shape: env.shape, unreadable };
}

// ── Describing a sample row ──────────────────────────────────────────────────

const MAX_DISTINCT_VALUES = 8;

/** The direction/status question, answered across several rows rather than one. */
export interface DistinctValues {
  key: string;
  values: readonly string[];
  truncated: boolean;
}

/**
 * Distinct values of every status-shaped key across the sampled rows. One value
 * across five rows is reported as such — it could be an enum or a constant, and
 * five rows cannot tell, which is itself the thing a reader needs to know.
 */
export function distinctStatusValues(rows: readonly unknown[]): DistinctValues[] {
  const seen = new Map<string, Set<string>>();
  for (const row of rows) {
    const d = buildRowKeyDiagnostic(row);
    if (d === null) continue;
    for (const n of d.notable) {
      if (n.kind !== "status") continue;
      const set = seen.get(n.key) ?? new Set<string>();
      set.add(n.value);
      seen.set(n.key, set);
    }
  }
  return [...seen.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, set]) => {
      const values = [...set].sort();
      return {
        key,
        values: values.slice(0, MAX_DISTINCT_VALUES),
        truncated: values.length > MAX_DISTINCT_VALUES,
      };
    });
}

function notableLine(label: string, keys: readonly NotableKey[]): string {
  return `    ${label}: ${keys.map((k) => `${k.key}="${k.value}"`).join(", ")}`;
}

/** The sample row as it appears in the log: key names, and only those values. */
export function describeSampleRow(table: string, d: RowKeyDiagnostic): string[] {
  const dates = d.notable.filter((n) => n.kind === "date");
  const statuses = d.notable.filter((n) => n.kind === "status");
  const lines = [
    `  ${table} SAMPLE ROW — key NAMES only, plus the VALUES of date- and status-shaped keys ` +
      `(those two decide the date basis, BLUEPRINT-DRAFT §2.4, and the stage model, §0.4). ` +
      `No other value is logged; a nested value contributes its shape and child key names only.`,
    `    wire keys (${d.keys.length}${d.keysTruncated ? ", first of more" : ""}, sorted, raw — ` +
      `name{a,b} means the value is a nested object): ${d.keys.join(", ") || "(none)"}`,
  ];
  lines.push(
    dates.length > 0
      ? notableLine("DATE-shaped keys", dates)
      : "    DATE-shaped keys: NONE on this row — no date basis is derivable from this table as it stands (§2.4 cannot be satisfied from it)",
  );
  lines.push(
    statuses.length > 0
      ? notableLine("STATUS/TYPE-shaped keys", statuses)
      : "    STATUS/TYPE-shaped keys: NONE on this row — this table does not say where a row is in the flow (§0.4)",
  );
  return lines;
}

// ── The run ──────────────────────────────────────────────────────────────────

export interface ProbeFailure {
  table: string;
  /** `tables`, `columns` or `sample` — which of the three requests failed. */
  endpoint: "tables" | "columns" | "sample";
  status: number | null;
  kind: SelarasFailureKind;
}

export type ProbeSkipReason =
  | "disabled"
  | "no_erp"
  | "no_credentials"
  | "already_ran"
  | "sync_busy"
  | "aborted";

export interface SchemaProbeResult {
  ran: boolean;
  skipped: ProbeSkipReason | null;
  /** Every HTTP request this run made, the table list included. */
  requests: number;
  /** Names `/tables` returned, or null when that request failed. */
  tablesListed: number | null;
  /** ERP table names actually probed, in the order they were probed. */
  probed: readonly string[];
  failures: readonly ProbeFailure[];
  durationMs: number;
}

export interface SchemaProbeDeps {
  log: SchemaProbeLogger;
  /** The sync's own in-process guard. The probe never competes with a run. */
  isSyncRunning: () => boolean;
  sleep: (ms: number) => Promise<void>;
  fetchJson: (opts: {
    label: string;
    erpTable?: string | null;
    url: string;
    dispatcher?: Dispatcher;
    retryDelayMs?: number;
  }) => Promise<ErpJsonResult>;
  now: () => number;
  /** Test seam, exactly as `FetchPageOptions.dispatcher` is. */
  dispatcher?: Dispatcher;
  /** Test seam: backoff before the single 5xx/network retry, as fetchPage has. */
  retryDelayMs?: number;
  /** Pace between requests. Defaults to the sync's own STOCK_SYNC_PAGE_DELAY_MS. */
  pageDelayMs?: number;
  /** How long to wait for the sync to go idle. Defaults to config. */
  waitForIdleMs?: number;
  /** How often to re-ask whether the sync is still running, while waiting. */
  idlePollMs?: number;
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0) resolve();
    else setTimeout(resolve, ms).unref?.();
  });
}

const DEFAULT_IDLE_POLL_MS = 5_000;

function defaults(): SchemaProbeDeps {
  return {
    log: defaultProbeLogger,
    isSyncRunning: isErpSyncRunning,
    sleep: sleepMs,
    fetchJson: (opts) => fetchErpJson(opts),
    now: () => Date.now(),
  };
}

/** One-shot, per process. Set the moment a run begins, never cleared. */
let hasRun = false;
/** Set by `stopErpSchemaProbe()`. An in-flight run stops at its next checkpoint. */
let aborted = false;
let armTimer: ReturnType<typeof setTimeout> | null = null;

/** Test seam: forget that the probe has run, and re-arm it. */
export function resetErpSchemaProbe(): void {
  hasRun = false;
  aborted = false;
  if (armTimer !== null) clearTimeout(armTimer);
  armTimer = null;
}

/** Chunked so a long list is never truncated mid-line by a log pipeline. */
const NAMES_PER_CHUNK = 20;
const MAX_CHUNK_CHARS = 1_200;

function chunkNames(names: readonly string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let chars = 0;
  for (const name of names) {
    if (current.length >= NAMES_PER_CHUNK || (current.length > 0 && chars + name.length > MAX_CHUNK_CHARS)) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(name);
    chars += name.length + 2;
  }
  if (current.length > 0) out.push(current);
  return out;
}

interface Target {
  name: string;
  why: string;
}

/**
 * Resolve the probe's target list: the PRD's five by name (prefixes resolved
 * against the listing), then every plausible name from the listing, minus the
 * four already mirrored, capped — and the cap's casualties are NAMED.
 */
export function selectTargets(
  listed: readonly string[],
  log: SchemaProbeLogger,
  maxTables = config.erpProbe.maxTables,
  extra: readonly string[] = config.erpProbe.extraTables,
): Target[] {
  const chosen = new Map<string, Target>();
  const add = (name: string, why: string): void => {
    if (MIRRORED.has(name)) return;
    if (!chosen.has(name)) chosen.set(name, { name, why });
  };

  for (const seed of SEED_TABLES) {
    if (!PREFIX_ONLY_RE.test(seed.name)) {
      add(seed.name, `PRD-NAMED — ${seed.why}`);
      continue;
    }
    const matches = listed.filter((n) => n.toLowerCase().startsWith(`${seed.name.toLowerCase()}_`));
    if (matches.length > 0) {
      for (const m of matches) add(m, `PRD-NAMED by number '${seed.name}' → resolved to '${m}' — ${seed.why}`);
      continue;
    }
    if (listed.length > 0) {
      // A finding, not a gap: the PRD's number is stale, or the API does not
      // expose that table. Either way it is one line, not silence.
      log.warn(
        `'${seed.name}' — the PRD cites this NUMBER (${seed.why}) but NO name in the /tables listing ` +
          `begins with '${seed.name}_'. Either the number is stale or the API does not expose it. ` +
          `Requesting the bare prefix anyway so the ERP's own answer is on the record.`,
      );
    }
    add(seed.name, `PRD-NAMED by number only — ${seed.why}. The bare prefix is being requested verbatim; a 404 here is itself the finding`);
  }

  for (const name of extra) add(name, "named explicitly in ERP_SCHEMA_PROBE_EXTRA_TABLES");

  const heuristic: Target[] = [];
  for (const name of listed) {
    if (chosen.has(name) || MIRRORED.has(name)) continue;
    const reason = relevanceReason(name);
    if (reason !== null) heuristic.push({ name, why: `matched loosely — ${reason}` });
  }

  const room = Math.max(0, maxTables - chosen.size);
  const kept = heuristic.slice(0, room);
  const trimmed = heuristic.slice(room);
  for (const t of kept) chosen.set(t.name, t);
  if (trimmed.length > 0) {
    log.warn(
      `ERP_SCHEMA_PROBE_MAX_TABLES=${maxTables} reached; ${trimmed.length} further plausible table(s) were ` +
        `NOT probed, and here they are by name so nobody has to guess what was skipped: ` +
        `${trimmed.map((t) => t.name).join(", ")}. Raise the cap, or list the ones you want in ` +
        `ERP_SCHEMA_PROBE_EXTRA_TABLES, and redeploy.`,
    );
  }
  return [...chosen.values()];
}

/**
 * Run the probe. RESOLVES ALWAYS — every failure is a value and a log line, so
 * there is no path from here to an unhandled rejection or a failed boot.
 */
export async function runErpSchemaProbeOnce(overrides: Partial<SchemaProbeDeps> = {}): Promise<SchemaProbeResult> {
  const deps: SchemaProbeDeps = { ...defaults(), ...overrides };
  const { log } = deps;
  const startedAt = deps.now();
  const idle = (skipped: ProbeSkipReason): SchemaProbeResult => ({
    ran: false,
    skipped,
    requests: 0,
    tablesListed: null,
    probed: [],
    failures: [],
    durationMs: deps.now() - startedAt,
  });

  if (!config.erpProbe.enabled) return idle("disabled");
  if (hasRun) {
    log.info("already ran in this process — the probe is one-shot by design; restart the service to run it again.");
    return idle("already_ran");
  }
  if (!hasErp) {
    log.warn("SELARAS_BASE_URL is not set, so there is no ERP to ask. Nothing was probed.");
    return idle("no_erp");
  }
  if (!hasErpCredentials) {
    log.warn(
      `no ERP credentials for auth mode '${config.selarasAuthMode}' — every request would be a 401. ` +
        "Set SELARAS_SECRET_KEY and SELARAS_SECRET_TOKEN (values are never logged). Nothing was probed.",
    );
    return idle("no_credentials");
  }
  hasRun = true;

  const pageDelayMs = deps.pageDelayMs ?? config.stock.syncPageDelayMs;
  const waitBudgetMs = deps.waitForIdleMs ?? config.erpProbe.waitForIdleMs;
  const idlePollMs = deps.idlePollMs ?? DEFAULT_IDLE_POLL_MS;
  const sampleLimit = Math.max(1, config.erpProbe.sampleLimit);
  const movementLimit = Math.max(sampleLimit, config.erpProbe.movementSampleLimit);

  let requests = 0;
  const failures: ProbeFailure[] = [];
  const probed: string[] = [];
  let tablesListed: number | null = null;
  let firstRequest = true;

  /**
   * The shared describers are the SYNC's, so a 429 message ends by talking about
   * cursors and committed pages. True for a mirror pull, meaningless for a
   * one-shot probe — which has no cursor and will not come back. One clause
   * rather than a second copy of the message.
   */
  const probeNote = (kind: SelarasFailureKind, status: number | null): string => {
    if (kind === "rate_limit") {
      return (
        " (PROBE NOTE: there is no next tick — this probe is one-shot, so this table's schema is simply " +
        "NOT in this log. Raise STOCK_SYNC_PAGE_DELAY_MS, or list just the missing tables in " +
        "ERP_SCHEMA_PROBE_EXTRA_TABLES, and redeploy with the flag still set.)"
      );
    }
    if (status === 404) {
      return (
        " A 404 here means the ERP has no table under THAT NAME — which is a finding, not a gap: " +
        "compare it against the complete /tables list above."
      );
    }
    return "";
  };

  const finish = (skipped: ProbeSkipReason | null): SchemaProbeResult => {
    const durationMs = deps.now() - startedAt;
    const line =
      `════════ END OF ERP SCHEMA PROBE ════════ ${requests} request(s) over ` +
      `${Math.round(durationMs / 100) / 10}s · ` +
      `${tablesListed === null ? "table list FAILED" : `${tablesListed} tables listed`} · ` +
      `${probed.length} probed · ${failures.length} failure(s)` +
      `${failures.length > 0 ? ` (${failures.map((f) => `${f.table}/${f.endpoint}:${f.status ?? f.kind}`).join(", ")})` : ""}` +
      `${skipped === null ? "" : ` · STOPPED EARLY: ${skipped}`} · ` +
      "nothing was written to the ERP or the mirror. " +
      "IF YOU CANNOT SEE THIS LINE THE OUTPUT ABOVE IS TRUNCATED. " +
      "Next: write the answers into docs/produksi-1.0/BLUEPRINT-DRAFT.md §0, then unset ERP_SCHEMA_PROBE.";
    log.info(line);
    return { ran: true, skipped, requests, tablesListed, probed, failures, durationMs };
  };

  /**
   * The rate-limit discipline, in one place: never beside a sync run, and never
   * faster than the sync's own pace. Returns false when the probe must stop.
   */
  const ready = async (): Promise<boolean> => {
    if (aborted) return false;
    if (!firstRequest && pageDelayMs > 0) await deps.sleep(pageDelayMs);
    firstRequest = false;
    const deadline = deps.now() + waitBudgetMs;
    let announced = false;
    while (deps.isSyncRunning()) {
      if (aborted) return false;
      if (deps.now() >= deadline) {
        log.warn(
          `a mirror sync has been in flight for the whole ${Math.round(waitBudgetMs / 1000)}s wait budget ` +
            "(ERP_SCHEMA_PROBE_WAIT_MS). STOPPING rather than sending probe requests alongside it: the ERP's " +
            "rate limiter is shared and this project has already had one production 429 loop. Re-deploy with " +
            "the flag still set and it will try again.",
        );
        return false;
      }
      if (!announced) {
        announced = true;
        log.info("a mirror sync is in flight — waiting for it to finish before touching the ERP (the limiter is shared).");
      }
      await deps.sleep(idlePollMs);
    }
    return !aborted;
  };

  log.info(
    "════════ ERP SCHEMA DISCOVERY PROBE ════════ ERP_SCHEMA_PROBE is set, so this runs ONCE and never " +
      "again in this process. It is READ-ONLY: GETs only, no writes, no schema changes, no cursor changes. " +
      `It paces itself at STOCK_SYNC_PAGE_DELAY_MS (${pageDelayMs}ms) and never runs beside a mirror sync. ` +
      "It answers docs/produksi-1.0/BLUEPRINT-DRAFT.md §0: the real names, columns, join key and date/stage " +
      "columns of the production tables, so the dashboard is not built against guessed column names again. " +
      "Secrets are never logged, on any path.",
  );

  // ── 1. The complete table list ─────────────────────────────────────────────
  let listed: readonly string[] = [];
  if (!(await ready())) return finish("sync_busy");
  requests += 1;
  const tablesRes = await deps.fetchJson({
    label: "tables",
    erpTable: null,
    url: buildErpPathUrl(["tables"]),
    dispatcher: deps.dispatcher,
    retryDelayMs: deps.retryDelayMs,
  });
  if (!tablesRes.ok) {
    failures.push({ table: "(tables)", endpoint: "tables", status: tablesRes.status, kind: tablesRes.kind });
    log.error(
      `GET <base>/tables FAILED — status ${tablesRes.status ?? "none"}, kind '${tablesRes.kind}': ${tablesRes.error}. ` +
        "The complete table list is therefore NOT in this log, and the Work Order table cannot be identified from " +
        "this run. The PRD-named tables below are still requested by name, because a name we already have does " +
        "not depend on the listing.",
    );
  } else {
    const reading = readTableList(tablesRes.body, sampleLimit);
    listed = reading.names;
    tablesListed = reading.names.length;
    const chunks = chunkNames(reading.names);
    log.info(
      `GET <base>/tables → HTTP ${tablesRes.status}, ${reading.names.length} table name(s). ` +
        `Envelope observed: ${reading.shape}. ` +
        `THE COMPLETE LIST FOLLOWS IN ${chunks.length} CHUNK(S) — nothing is filtered and nothing is truncated. ` +
        "The owner's words were 'request produksi' and 'work order', which need not match the ERP's naming, so " +
        "read the whole thing: a table discarded here is one nobody can ask about later.",
    );
    if (reading.unreadable.length > 0) {
      log.warn(
        `${reading.unreadable.length} entry(ies) in the /tables response carried no readable table name. ` +
          `Their own key shapes, so the reader shape can be corrected: ${reading.unreadable.slice(0, 5).join(" ")}`,
      );
    }
    chunks.forEach((chunk, i) => {
      const from = i * NAMES_PER_CHUNK + 1;
      log.info(`  tables ${from}–${from + chunk.length - 1} of ${reading.names.length}: ${chunk.join(", ")}`);
    });
    if (reading.names.length === 0) {
      log.warn(
        "the /tables response parsed to ZERO names. That is a reader problem, not an empty ERP — see the envelope " +
          "shape above and correct readTableList() in erp/schemaProbe.ts.",
      );
    }
  }

  // ── 2. Which tables to ask about ───────────────────────────────────────────
  const targets = selectTargets(listed, log);
  log.info(
    `probing ${targets.length} table(s): the ${SEED_TABLES.length} the PRD already names (prefix-only numbers ` +
      `resolved against the listing), plus every listed name that plausibly relates to production, work orders, ` +
      `material, BOM or warehouse movement. The ${MIRRORED.size} tables the sync already mirrors ` +
      `(${[...MIRRORED].join(", ")}) are DELIBERATELY SKIPPED — their columns are settled and ` +
      "STOCK_SYNC_DIAGNOSE_COLUMNS already prints them. Each table costs 2 requests (columns, then one sample row).",
  );

  // ── 3. Columns and one sample row, per table ───────────────────────────────
  for (const target of targets) {
    if (!(await ready())) return finish(aborted ? "aborted" : "sync_busy");
    probed.push(target.name);
    log.info(`── ${target.name} ── (${target.why})`);

    requests += 1;
    const colRes = await deps.fetchJson({
      label: `${target.name}/columns`,
      erpTable: target.name,
      url: buildErpPathUrl(["table", target.name, "columns"]),
      dispatcher: deps.dispatcher,
      retryDelayMs: deps.retryDelayMs,
    });
    if (!colRes.ok) {
      failures.push({ table: target.name, endpoint: "columns", status: colRes.status, kind: colRes.kind });
      log.error(
        `  ${target.name} COLUMNS FAILED — status ${colRes.status ?? "none"}, kind '${colRes.kind}': ${colRes.error}` +
          probeNote(colRes.kind, colRes.status),
      );
    } else {
      const reading = readColumnList(colRes.body, sampleLimit);
      log.info(
        `  ${target.name} COLUMNS — HTTP ${colRes.status}, ${reading.columns.length} column(s). ` +
          `Envelope observed: ${reading.shape}`,
      );
      if (reading.unreadable.length > 0) {
        log.warn(
          `  ${target.name}: ${reading.unreadable.length} column entry(ies) unreadable; their key shapes: ` +
            reading.unreadable.slice(0, 5).join(" "),
        );
      }
      for (const chunk of chunkColumns(reading.columns)) log.info(`    ${chunk}`);
      if (reading.columns.length === 0) {
        log.warn(
          `  ${target.name}: the columns endpoint answered 200 but parsed to ZERO columns. See the envelope shape ` +
            "above — this is a reader problem, not an empty table.",
        );
      }
    }

    if (!(await ready())) return finish(aborted ? "aborted" : "sync_busy");
    const limit = target.name === MOVEMENT_TABLE ? movementLimit : sampleLimit;
    requests += 1;
    const rowRes = await deps.fetchJson({
      label: `${target.name}/sample`,
      erpTable: target.name,
      url: buildErpPathUrl(["table", target.name], { limit: String(limit), page: "1" }),
      dispatcher: deps.dispatcher,
      retryDelayMs: deps.retryDelayMs,
    });
    if (!rowRes.ok) {
      failures.push({ table: target.name, endpoint: "sample", status: rowRes.status, kind: rowRes.kind });
      log.error(
        `  ${target.name} SAMPLE ROW FAILED — status ${rowRes.status ?? "none"}, kind '${rowRes.kind}': ${rowRes.error}. ` +
          "The column list above (if it succeeded) still stands; only the live key spellings are missing." +
          probeNote(rowRes.kind, rowRes.status),
      );
      continue;
    }
    const env = readEnvelope(rowRes.body, limit);
    if (env.rows.length === 0) {
      log.warn(
        `  ${target.name} SAMPLE ROW — HTTP ${rowRes.status}, but the page returned NO ROWS (envelope: ${env.shape}). ` +
          "The table exists and is empty, or every row is filtered out. Either way no live key spelling is available " +
          "from it — and an empty production table is itself worth knowing.",
      );
      continue;
    }
    const diag = buildRowKeyDiagnostic(env.rows[0]);
    if (diag === null) {
      log.warn(
        `  ${target.name} SAMPLE ROW — HTTP ${rowRes.status}, ${env.rows.length} row(s), but the first row was not an ` +
          `object (${unreadableShape(env.rows[0])}). Envelope: ${env.shape}`,
      );
      continue;
    }
    for (const line of describeSampleRow(target.name, diag)) log.info(line);

    if (target.name === MOVEMENT_TABLE) {
      // §0.5 — the whole open product risk. One value across N rows cannot tell
      // an enum from a constant, and that distinction is what decides whether
      // "movement" is derivable at all, so it is reported explicitly.
      const distinct = distinctStatusValues(env.rows.slice(0, limit));
      log.info(
        `    ${MOVEMENT_TABLE} DIRECTION/STATUS CANDIDATES across ${env.rows.length} sampled row(s) — ` +
          "this is the §0.5 question: does the ERP say which way the goods went?",
      );
      if (distinct.length === 0) {
        log.warn(
          `      NONE. No status-, type- or direction-shaped key on these rows. If that holds over the whole table, ` +
            "raw-material/FG movement DIRECTION is not derivable from this table and the dashboard's scope must be " +
            "narrowed explicitly rather than implied (BLUEPRINT-DRAFT §1).",
        );
      }
      for (const d of distinct) {
        const note =
          d.values.length === 1
            ? "  ← ONE value across every sampled row: an enum with a dominant value, or a constant. These rows cannot tell; raise ERP_SCHEMA_PROBE_MOVEMENT_SAMPLE_LIMIT to find out."
            : "";
        log.info(
          `      ${d.key}: ${d.values.length}${d.truncated ? "+" : ""} distinct — ` +
            `${d.values.map((v) => `"${v}"`).join(", ")}${note}`,
        );
      }
    }
  }

  return finish(null);
}

const COLUMNS_PER_LINE = 8;

function chunkColumns(columns: readonly ErpColumn[]): string[] {
  const rendered = columns.map(
    (c) => `${c.name}:${c.type ?? "?"}${c.extra === null ? "" : ` [${c.extra}]`}`,
  );
  const out: string[] = [];
  for (let i = 0; i < rendered.length; i += COLUMNS_PER_LINE) {
    out.push(rendered.slice(i, i + COLUMNS_PER_LINE).join(" · "));
  }
  return out;
}

/**
 * Boot hook. Mirrors `startErpSync()`: arm, never throw, and be completely inert
 * when the flag is unset — no timer, no request, not even a log line, so a
 * normal deploy carries no trace of this module at all.
 *
 * The timer is unref'd and fires AFTER `app.listen()`, so the probe can neither
 * delay a boot nor hold the process open at shutdown.
 */
export function startErpSchemaProbe(): void {
  if (!config.erpProbe.enabled) return;
  if (armTimer !== null || hasRun) return;
  aborted = false;
  const delay = config.erpProbe.delayMs;
  console.info(
    `[erp-probe] ARMED — ERP_SCHEMA_PROBE is set, so a ONE-SHOT, read-only schema probe will run in ` +
      `${Math.round(delay / 1000)}s (ERP_SCHEMA_PROBE_DELAY_MS), once the app is serving and no mirror sync is ` +
      "in flight. It writes nothing. Unset the flag once you have read its output.",
  );
  armTimer = setTimeout(() => {
    armTimer = null;
    void runErpSchemaProbeOnce().catch((err) => {
      // runErpSchemaProbeOnce() resolves rather than rejecting; this exists so
      // that a probe can NEVER produce an unhandled rejection even if that ever
      // stops being true. The app has to keep serving if this thing fails.
      console.error(`[erp-probe] probe aborted on an unexpected error: ${redactSecrets(err)}`);
    });
  }, delay);
  armTimer.unref?.();
}

/** Disarm, and tell an in-flight run to stop at its next checkpoint. */
export function stopErpSchemaProbe(): void {
  aborted = true;
  if (armTimer !== null) clearTimeout(armTimer);
  armTimer = null;
}
