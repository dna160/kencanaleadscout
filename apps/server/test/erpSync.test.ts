/**
 * WP-2 — Selaras client + sync worker (CONTRACTS §5).
 *
 * Four things must be PROVEN here, not asserted in prose:
 *   1. Running one sync window twice produces byte-identical mirror rows and
 *      identical ATP. That is the acceptance criterion (§5).
 *   2. A failed page does not advance the cursor (ST-R7).
 *   3. A malformed row does not crash the run.
 *   4. `SELARAS_TOKEN` never reaches a log line or a stored error (§7.9).
 *
 * NO NETWORK, EVER. The HTTP layer is driven by undici's MockAgent with
 * `disableNetConnect()`, installed as the global dispatcher — which means these
 * tests exercise the REAL `selarasClient` end to end (URL building, envelope
 * detection, every adapter, retry policy) rather than a stub of it. The only
 * thing faked is the ERP itself.
 *
 * The mirror half needs a real Postgres: an idempotent upsert against a fake
 * `Sql` object would prove nothing about `on conflict do update`. The suite
 * connects to a local Postgres and creates its OWN schema, so it never touches
 * the developer's data and never fights WP-7's fixtures. When no database is
 * reachable the DB-backed block skips with a clear message and the pure tests —
 * envelope tolerance, adapters, redaction — still run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";

// ── Environment must be set BEFORE config.ts is evaluated ────────────────────
// config.ts freezes env into a const at import time, so every module under test
// is pulled in dynamically after these assignments.

/** Deliberately distinctive: every assertion below greps for this exact string. */
const TOKEN = "tok_live_WP2_SECRET_9f3a2b_must_never_be_logged";
const BASE_URL = "http://erp.test/api";
const PAGE_SIZE = 2; // small, so multi-page paging is genuinely exercised

process.env["SELARAS_BASE_URL"] = BASE_URL;
process.env["SELARAS_TOKEN"] = TOKEN;
process.env["SELARAS_TIMEOUT_MS"] = "3000";
process.env["STOCK_SYNC_PAGE_SIZE"] = String(PAGE_SIZE);
process.env["STOCK_SYNC_INTERVAL_MS"] = "60000";
process.env["STOCK_STALE_WINDOW_DAYS"] = "60";

const clientMod = await import("../src/erp/selarasClient.js");
const workerMod = await import("../src/erp/syncWorker.js");
const migrateMod = await import("../src/db/migrateErpStock.js");
const skuMod = await import("../src/erp/sku.js");

const {
  adaptLiveFgRow,
  adaptSoHeaderRow,
  adaptSoLineRow,
  buildPageUrl,
  fetchPage,
  readEnvelope,
  redactSecrets,
  resetShapeNotices,
} = clientMod;
const { runErpSyncOnce } = workerMod;
const { canonicalSkuKey } = skuMod;

type SelarasTable = clientMod.SelarasTable;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function loadFixture(name: string): unknown[] {
  const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as { rows: unknown[] };
  return parsed.rows;
}

const FIXTURES: Record<SelarasTable, unknown[]> = {
  so_header: loadFixture("selaras-so-header.json"),
  so_line: loadFixture("selaras-so-line.json"),
  live_fg: loadFixture("selaras-live-fg.json"),
};

/** ERP table name (what the URL carries) → our logical table name. */
const ERP_TABLE_TO_LOGICAL: Record<string, SelarasTable> = {
  tbl_1202_SOSalesOrderNID: "so_header",
  tbl_1203_SOSalesOrderDetailNID: "so_line",
  tbl_1210_STLiveFGMX: "live_fg",
};

/**
 * Read `updated_at` out of a raw fixture row under any of its three casings.
 * An absent or unreadable value sorts LAST and is never filtered out by the
 * cursor — which is how Postgres behaves for `order by updated_at asc` (NULLs
 * last) and the conservative reading of a `>=` filter over a NULL column.
 */
function rawUpdatedAtMs(row: unknown): number {
  if (typeof row !== "object" || row === null) return Number.POSITIVE_INFINITY;
  const rec = row as Record<string, unknown>;
  const raw = rec["updated_at"] ?? rec["updatedAt"] ?? rec["UpdatedAt"];
  if (typeof raw !== "string") return Number.POSITIVE_INFINITY;
  const norm = /Z|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`;
  const t = new Date(norm).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

// ── The fake ERP ─────────────────────────────────────────────────────────────
//
// Three DIFFERENT envelope shapes on purpose, one per table, so a single run
// proves the A1 assumption and both tolerated alternatives at once:
//   so_header → `{ data, meta: { page, total_pages } }`   (A1, the assumption)
//   so_line   → `{ results, total }`                      (row count → page count)
//   live_fg   → a bare array                              (no envelope at all)

type Envelope = "a1" | "results_total" | "bare_array";

const ENVELOPE_BY_TABLE: Record<SelarasTable, Envelope> = {
  so_header: "a1",
  so_line: "results_total",
  live_fg: "bare_array",
};

interface ErpFault {
  /** `${table}:${page}` → HTTP status to answer with instead of data. */
  status?: Record<string, number>;
  /** `${table}:${page}` → answer 200 with a non-JSON body (a login page, say). */
  garbage?: Record<string, string>;
}

let faults: ErpFault = {};
let requestLog: string[] = [];

function erpRespond(path: string): { statusCode: number; data: unknown; headers: Record<string, string> } {
  requestLog.push(path);
  const url = new URL(path, BASE_URL);
  const erpTable = url.pathname.split("/").pop() ?? "";
  const table = ERP_TABLE_TO_LOGICAL[erpTable];
  if (!table) return { statusCode: 404, data: "unknown table", headers: {} };

  const page = Number(url.searchParams.get("page") ?? "1");
  const limit = Number(url.searchParams.get("limit") ?? String(PAGE_SIZE));
  const key = `${table}:${page}`;

  const status = faults.status?.[key];
  if (status !== undefined) return { statusCode: status, data: `upstream said ${status}`, headers: {} };
  const garbage = faults.garbage?.[key];
  if (garbage !== undefined) {
    return { statusCode: 200, data: garbage, headers: { "content-type": "text/html" } };
  }

  const since = url.searchParams.get("updated_at__gte");
  const sinceMs = since ? new Date(since).getTime() : Number.NEGATIVE_INFINITY;

  // `__gte` + ascending `updated_at`, exactly as PRD §4 specifies (A2).
  const matching = FIXTURES[table]
    .filter((r) => rawUpdatedAtMs(r) >= sinceMs)
    .sort((a, b) => rawUpdatedAtMs(a) - rawUpdatedAtMs(b));
  const slice = matching.slice((page - 1) * limit, page * limit);

  const headers = { "content-type": "application/json" };
  switch (ENVELOPE_BY_TABLE[table]) {
    case "a1":
      return {
        statusCode: 200,
        data: { data: slice, meta: { page, total_pages: Math.max(1, Math.ceil(matching.length / limit)) } },
        headers,
      };
    case "results_total":
      return { statusCode: 200, data: { results: slice, total: matching.length }, headers };
    case "bare_array":
      return { statusCode: 200, data: slice, headers };
  }
}

let mockAgent: MockAgent;
let previousDispatcher: Dispatcher;

beforeAll(() => {
  previousDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect(); // a leaked real request fails loudly instead of hanging
  mockAgent
    .get("http://erp.test")
    .intercept({ path: (p: string) => p.startsWith("/api/"), method: "GET" })
    .reply((opts) => {
      const res = erpRespond(String(opts.path));
      return { statusCode: res.statusCode, data: res.data, responseOptions: { headers: res.headers } };
    })
    .persist();
  setGlobalDispatcher(mockAgent);
});

afterAll(async () => {
  setGlobalDispatcher(previousDispatcher);
  await mockAgent.close();
});

beforeEach(() => {
  faults = {};
  requestLog = [];
});

// ── 1. The client's assumptions, isolated ────────────────────────────────────

describe("selarasClient — URL contract (PRD §4, assumption A2)", () => {
  it("builds the documented query string, with __gte so no boundary row is skipped", () => {
    const url = new URL(buildPageUrl("so_line", { since: new Date("2026-09-01T02:00:00Z"), page: 3, limit: 500 }));
    expect(url.pathname).toBe("/api/tbl_1203_SOSalesOrderDetailNID");
    expect(url.searchParams.get("updated_at__gte")).toBe("2026-09-01T02:00:00.000Z");
    expect(url.searchParams.get("order_by")).toBe("updated_at");
    expect(url.searchParams.get("order_dir")).toBe("asc");
    expect(url.searchParams.get("limit")).toBe("500");
    expect(url.searchParams.get("page")).toBe("3");
  });

  it("omits the cursor entirely on a first, full pull", () => {
    const url = new URL(buildPageUrl("live_fg", { since: null, page: 1, limit: 10 }));
    expect(url.searchParams.has("updated_at__gte")).toBe(false);
  });

  it("never puts the token in the URL", () => {
    expect(buildPageUrl("so_header", { since: null, page: 1, limit: 10 })).not.toContain(TOKEN);
  });
});

describe("readEnvelope — assumes A1, tolerates the alternatives (HANDOVER §2)", () => {
  it("reads the assumed A1 shape and flags it as matching", () => {
    const env = readEnvelope({ data: [{ id: 1 }], meta: { page: 1, total_pages: 7 } }, 100);
    expect(env.rows).toHaveLength(1);
    expect(env.totalPages).toBe(7);
    expect(env.matchedAssumption).toBe(true);
  });

  it.each([
    ["bare array", [{ id: 1 }, { id: 2 }], null],
    ["results + total", { results: [{ id: 1 }, { id: 2 }], total: 5 }, 3],
    ["items + count", { items: [{ id: 1 }, { id: 2 }], count: 4 }, 2],
    ["rows + pagination.last_page", { rows: [{ id: 1 }], pagination: { last_page: 9 } }, 9],
    ["data nested one level", { data: { items: [{ id: 1 }] } }, null],
  ])("tolerates %s instead of throwing", (_name, body, expectedPages) => {
    const env = readEnvelope(body, 2);
    expect(env.rows.length).toBeGreaterThan(0);
    expect(env.totalPages).toBe(expectedPages);
    expect(env.matchedAssumption).toBe(false);
  });

  it.each([[null], [undefined], ["a string"], [42], [{ unexpected: "keys" }]])(
    "degrades an unreadable body (%s) to zero rows rather than throwing",
    (body) => {
      const env = readEnvelope(body, 10);
      expect(env.rows).toEqual([]);
      expect(env.matchedAssumption).toBe(false);
      expect(env.shape).toBeTruthy();
    },
  );

  it("logs the observed shape ONCE, clearly enough to correct A1 from the log line", async () => {
    resetShapeNotices();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // live_fg answers with a bare array; two fetches, one notice.
      await fetchPage("live_fg", { since: null, page: 1, limit: PAGE_SIZE });
      await fetchPage("live_fg", { since: null, page: 2, limit: PAGE_SIZE });
      const notices = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("envelope"));
      expect(notices).toHaveLength(1);
      expect(notices[0]).toContain("live_fg");
      expect(notices[0]).toContain("bare array");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("adapters — one per table, indifferent to casing (A2)", () => {
  it("adapts snake_case, camelCase and PascalCase rows alike", () => {
    const header = adaptSoHeaderRow(FIXTURES.so_header[0]);
    expect(header?.id).toBe("SOH-1001");
    expect(header?.customer_name_text).toBe("PT Sinar Mandiri");

    const line = adaptSoLineRow(FIXTURES.so_line[0]); // camelCase fixture
    expect(line?.id).toBe("SOL-2001");
    expect(line?.qty_balance).toBe(319);
    expect(line?.estimate_delivery).toBe("2099-09-20");

    const fg = adaptLiveFgRow(FIXTURES.live_fg[0]); // PascalCase fixture
    expect(fg?.sn_fg).toBe("FG-0001");
    expect(fg?.qty).toBe(2084);
    expect(fg?.lokasi).toBe("GD-01");
  });

  it("computes sku_key through canonicalSkuKey(), never its own copy (§7.4)", () => {
    const line = adaptSoLineRow(FIXTURES.so_line[0]);
    const fg = adaptLiveFgRow(FIXTURES.live_fg[0]);
    const expected = canonicalSkuKey({ kode_barang: "ACP-4MM", warna: "004", th: 0.3, p: 4880, l: 1220 });
    expect(line?.sku_key).toBe(expected);
    expect(fg?.sku_key).toBe(expected);
    // Demand and supply must land on the SAME key or open_commitment under-counts.
    expect(line?.sku_key).toBe(fg?.sku_key);
  });

  it("normalizes messy-but-valid values ('0.30', ' 004 ', '1,810', dd/mm/yyyy) onto that same key", () => {
    const messy = adaptSoLineRow(FIXTURES.so_line[1]);
    const clean = adaptSoLineRow(FIXTURES.so_line[0]);
    expect(messy?.sku_key).toBe(clean?.sku_key);
    expect(messy?.qty_balance).toBe(1810);
    expect(messy?.estimate_delivery).toBe("2020-05-11");
  });

  it("drops an unkeyable row instead of throwing", () => {
    expect(adaptSoHeaderRow(FIXTURES.so_header[3])).toBeNull(); // no id
    expect(adaptLiveFgRow(FIXTURES.live_fg[4])).toBeNull(); // no serial
    expect(adaptLiveFgRow(null)).toBeNull();
    expect(adaptSoLineRow("ini bukan baris sama sekali")).toBeNull();
  });

  it("degrades a fully malformed row to nulls and zeros — never NaN, which numeric rejects", () => {
    const row = adaptSoLineRow(FIXTURES.so_line[6]);
    expect(row).not.toBeNull();
    expect(row?.qty_balance).toBe(0); // 'bukan angka' → 0, the schema default
    expect(row?.qty_order).toBeNull();
    expect(row?.th).toBeNull();
    expect(row?.estimate_delivery).toBeNull();
    expect(row?.erp_updated_at).toBeNull(); // ⇒ the cursor cannot advance on it
    expect(Number.isNaN(row?.qty_balance)).toBe(false);
  });
});

describe("fetchPage — transport posture (§5)", () => {
  it("retries once on 5xx, then reports a redacted failure instead of throwing", async () => {
    faults = { status: { "so_header:1": 503 } };
    const res = await fetchPage("so_header", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(503);
      expect(res.error).not.toContain(TOKEN);
    }
    expect(requestLog).toHaveLength(2); // the attempt plus exactly one retry
  });

  it("does NOT retry a 4xx — a 401/404 is a configuration fault, not a blip", async () => {
    faults = { status: { "so_header:1": 401 } };
    const res = await fetchPage("so_header", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok).toBe(false);
    expect(requestLog).toHaveLength(1);
  });

  it("reports a non-JSON body by LENGTH only — an auth page quotes the token back", async () => {
    faults = { garbage: { "so_header:1": `Unauthorized for Bearer ${TOKEN}` } };
    const res = await fetchPage("so_header", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).not.toContain(TOKEN);
      expect(res.error).toContain("non-JSON");
    }
    expect(requestLog).toHaveLength(1); // a shape fault; retrying would only hide it
  });
});

// ── 2. Secret handling (invariant §7.9) ──────────────────────────────────────

describe("redactSecrets — the token never survives a round trip to a log", () => {
  it("scrubs the literal token out of an error message", () => {
    const err = new Error(`GET ${BASE_URL}/x failed; sent authorization: Bearer ${TOKEN}`);
    const text = redactSecrets(err);
    expect(text).not.toContain(TOKEN);
    expect(text).toContain("***");
  });

  it("does not stringify a request-options object hung off an error — the classic leak", () => {
    // undici and node-fetch both decorate transport errors this way. `String(err)`
    // or `util.inspect(err)` would print the authorization header verbatim.
    const err = new Error("socket hang up") as Error & { options?: unknown };
    err.options = { headers: { authorization: `Bearer ${TOKEN}` }, origin: BASE_URL };
    (err as NodeJS.ErrnoException).code = "ECONNRESET";
    const text = redactSecrets(err);
    expect(text).not.toContain(TOKEN);
    expect(text).toBe("socket hang up (ECONNRESET)");
  });

  it("scrubs a bearer value it has never seen before, and a ?token= query param", () => {
    expect(redactSecrets("authorization: Bearer some_other_unknown_secret")).not.toContain("some_other_unknown_secret");
    expect(redactSecrets("GET /x?token=abc123def&page=1")).toBe("GET /x?token=***&page=1");
  });
});

// ── 3. The worker, against a real Postgres ───────────────────────────────────

const TEST_DB_URL = process.env["TEST_DATABASE_URL"] ?? "postgres://kencana:kencana@localhost:5432/leadscout";
const TEST_SCHEMA = "wp2_erp_sync_test";

async function connectTestDb(): Promise<postgres.Sql<{}> | null> {
  try {
    const admin = postgres(TEST_DB_URL, { max: 1, idle_timeout: 0, connect_timeout: 5, onnotice: () => {} });
    await admin`select 1`;
    await admin`drop schema if exists ${admin.unsafe(TEST_SCHEMA)} cascade`;
    await admin`create schema ${admin.unsafe(TEST_SCHEMA)}`;
    await admin.end();
    // Its OWN schema, so the suite never touches developer data and never races
    // another work package's fixtures. max:1 keeps search_path on one session.
    return postgres(TEST_DB_URL, {
      max: 1,
      idle_timeout: 0,
      connect_timeout: 5,
      onnotice: () => {},
      connection: { search_path: `${TEST_SCHEMA},public` },
    });
  } catch {
    return null;
  }
}

const db = await connectTestDb();
if (db === null) {
  console.warn(
    `[erpSync.test] no Postgres at ${TEST_DB_URL.replace(/:\/\/[^@]*@/, "://***@")} — ` +
      "the mirror/idempotency block is SKIPPED. Start Postgres 16 (or set TEST_DATABASE_URL) to run it.",
  );
}

type JsonRow = { row: Record<string, unknown> };
type AtpRow = { sku_key: string; on_hand: string; committed: string; atp: string };

/**
 * Every mirrored business column, minus `synced_at`. `synced_at` is deliberately
 * excluded: it records when a row was last CONFIRMED against the ERP and so
 * changes on every upsert by design. It is sync bookkeeping, not mirrored
 * content, and nothing in the ATP formula reads it (CONTRACTS §0).
 */
async function mirrorSnapshot(sql: postgres.Sql<{}>): Promise<Record<string, unknown[]>> {
  const header = await sql<JsonRow[]>`select to_jsonb(t) - 'synced_at' as row from erp_so_header t order by id`;
  const line = await sql<JsonRow[]>`select to_jsonb(t) - 'synced_at' as row from erp_so_line t order by id`;
  const fg = await sql<JsonRow[]>`select to_jsonb(t) - 'synced_at' as row from erp_live_fg t order by sn_fg`;
  return {
    erp_so_header: header.map((r) => r.row),
    erp_so_line: line.map((r) => r.row),
    erp_live_fg: fg.map((r) => r.row),
  };
}

/**
 * ATP(sku) = on_hand − open_commitment (no adjustments exist in this fixture).
 * `open_commitment` is read from `v_live_commitments` and nowhere else, so this
 * test cannot accidentally re-spell the liveness predicate (invariant §7.3).
 * Numerics come back as strings, which is what makes "identical" mean identical.
 */
async function atpSnapshot(sql: postgres.Sql<{}>): Promise<AtpRow[]> {
  return sql<AtpRow[]>`
    with on_hand as (select sku_key, sum(qty) as qty from erp_live_fg group by sku_key),
         committed as (select sku_key, sum(qty_balance) as qty from v_live_commitments group by sku_key)
    select coalesce(o.sku_key, c.sku_key) as sku_key,
           coalesce(o.qty, 0)::text as on_hand,
           coalesce(c.qty, 0)::text as committed,
           (coalesce(o.qty, 0) - coalesce(c.qty, 0))::text as atp
      from on_hand o
      full join committed c on c.sku_key = o.sku_key
     order by 1
  `;
}

async function resetCursors(sql: postgres.Sql<{}>): Promise<void> {
  await sql`
    update erp_sync_state
       set cursor_value = null, last_error = null, last_error_at = null, running = false, rows_synced = 0
  `;
}

async function syncStateRows(sql: postgres.Sql<{}>) {
  return sql<{ table_name: string; cursor_value: Date | null; last_error: string | null; running: boolean }[]>`
    select table_name, cursor_value, last_error, running from erp_sync_state order by table_name
  `;
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function run(sql: postgres.Sql<{}>, log = silentLog) {
  return runErpSyncOnce({ db: sql, pageSize: PAGE_SIZE, intervalMs: 60_000, log });
}

describe.skipIf(db === null)("syncWorker — against a real mirror schema", () => {
  const sql = db as postgres.Sql<{}>;

  beforeAll(async () => {
    await migrateMod.runErpStockMigrations(sql);
    // If WP-1's migration silently failed, every assertion below would be
    // meaningless, so prove the schema is actually there first.
    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = ${TEST_SCHEMA} order by 1
    `;
    const names = tables.map((t) => t.table_name);
    expect(names).toContain("erp_so_header");
    expect(names).toContain("erp_so_line");
    expect(names).toContain("erp_live_fg");
    expect(names).toContain("erp_sync_state");
  });

  afterAll(async () => {
    await sql`drop schema if exists ${sql.unsafe(TEST_SCHEMA)} cascade`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`truncate erp_so_header, erp_so_line, erp_live_fg`;
    await resetCursors(sql);
  });

  it("mirrors the fixture window, paging through all three tables in order", async () => {
    const result = await run(sql);
    expect(result.started).toBe(true);
    expect(result.tables.map((t) => t.table)).toEqual(["so_header", "so_line", "live_fg"]);
    expect(result.tables.every((t) => t.ok)).toBe(true);

    const counts = await sql<{ h: number; l: number; f: number }[]>`
      select (select count(*)::int from erp_so_header) as h,
             (select count(*)::int from erp_so_line)   as l,
             (select count(*)::int from erp_live_fg)   as f
    `;
    expect(counts[0]).toEqual({ h: 3, l: 6, f: 4 });

    // PRD §5A: the two Black Galaxy rolls sum to 4,168 lembar on hand.
    const onHand = await sql<{ qty: string }[]>`
      select sum(qty)::text as qty from erp_live_fg where kode_barang = 'ACP-4MM'
    `;
    expect(onHand[0]?.qty).toBe("4168");

    // AMENDMENT 1: the undated approved line is mirrored with a NULL ETA — it is
    // real, undated demand, not a row to be dropped on the floor.
    const undated = await sql<{ id: string; estimate_delivery: Date | null }[]>`
      select id, estimate_delivery from erp_so_line where id = 'SOL-2004'
    `;
    expect(undated[0]?.estimate_delivery).toBeNull();
  });

  it("IS IDEMPOTENT: three runs over the same window leave identical rows and identical ATP", async () => {
    await run(sql);
    const mirrorAfterFirst = await mirrorSnapshot(sql);
    const atpAfterFirst = await atpSnapshot(sql);
    expect(atpAfterFirst.length).toBeGreaterThan(0);

    // Rewind the cursor so runs 2 and 3 re-pull the WHOLE window, not just the
    // tail. This is the literal acceptance criterion in CONTRACTS §5: "running a
    // sync once or ten times over the same window yields byte-identical mirror
    // state and identical ATP."
    for (let i = 0; i < 2; i += 1) {
      await resetCursors(sql);
      const again = await run(sql);
      expect(again.started).toBe(true);
      expect(again.tables.every((t) => t.ok)).toBe(true);
    }

    expect(await mirrorSnapshot(sql)).toEqual(mirrorAfterFirst);
    expect(await atpSnapshot(sql)).toEqual(atpAfterFirst);
  });

  it("is idempotent under a duplicated primary key inside one page", async () => {
    // An ERP paging a table that is being written can emit the same row twice.
    // `on conflict do update` refuses to touch a row twice in one statement, so
    // the batch must be deduped — otherwise the whole page would roll back.
    const original = FIXTURES.live_fg;
    FIXTURES.live_fg = [original[0], original[0], original[1]] as unknown[];
    try {
      const result = await run(sql);
      expect(result.tables.find((t) => t.table === "live_fg")?.ok).toBe(true);
      const rows = await sql<{ n: number }[]>`select count(*)::int as n from erp_live_fg where sn_fg = 'FG-0001'`;
      expect(rows[0]?.n).toBe(1);
    } finally {
      FIXTURES.live_fg = original;
    }
  });

  it("does NOT advance the cursor when the FIRST page of a table fails (ST-R7)", async () => {
    await run(sql); // a good run first, so there is a mirror worth preserving
    const mirrorBefore = await mirrorSnapshot(sql);
    const cursorsBefore = await syncStateRows(sql);

    faults = { status: { "so_line:1": 500 } };
    const result = await run(sql);

    const soLine = result.tables.find((t) => t.table === "so_line");
    expect(soLine?.ok).toBe(false);
    expect(soLine?.cursorAfter?.getTime()).toBe(soLine?.cursorBefore?.getTime());

    const cursorsAfter = await syncStateRows(sql);
    const before = cursorsBefore.find((r) => r.table_name === "so_line");
    const after = cursorsAfter.find((r) => r.table_name === "so_line");
    expect(after?.cursor_value?.getTime()).toBe(before?.cursor_value?.getTime());
    expect(after?.last_error).toBeTruthy();
    expect(after?.last_error).not.toContain(TOKEN);
    expect(after?.running).toBe(false); // the guard is always released

    // ST-R7: the old mirror stays readable. A broken ERP costs freshness, not data.
    expect(await mirrorSnapshot(sql)).toEqual(mirrorBefore);
  });

  it("keeps the cursor at the last COMMITTED page when a later page fails", async () => {
    faults = { status: { "so_line:2": 500 } };
    const result = await run(sql);

    const soLine = result.tables.find((t) => t.table === "so_line");
    expect(soLine?.ok).toBe(false);
    expect(soLine?.pages).toBe(1); // page 1 committed, page 2 blew up

    // so_line page 1 (pageSize 2, ascending updated_at) is SOL-2001 + SOL-2002.
    const rows = await sql<{ id: string }[]>`select id from erp_so_line order by id`;
    expect(rows.map((r) => r.id)).toEqual(["SOL-2001", "SOL-2002"]);

    const state = (await syncStateRows(sql)).find((r) => r.table_name === "so_line");
    // Exactly page 1's high-water mark — not page 2's, and not null.
    expect(state?.cursor_value?.toISOString()).toBe("2026-09-01T03:35:00.000Z");

    // And the next run resumes from there and completes the window.
    faults = {};
    const recovery = await run(sql);
    expect(recovery.tables.find((t) => t.table === "so_line")?.ok).toBe(true);
    const after = await sql<{ n: number }[]>`select count(*)::int as n from erp_so_line`;
    expect(after[0]?.n).toBe(6);
  });

  it("survives malformed rows: they are dropped and counted, the run still succeeds", async () => {
    const result = await run(sql);
    expect(result.started).toBe(true);
    expect(result.tables.every((t) => t.ok)).toBe(true);

    const soLine = result.tables.find((t) => t.table === "so_line");
    const liveFg = result.tables.find((t) => t.table === "live_fg");
    expect(soLine?.dropped).toBe(2); // the id-less row and the bare string
    expect(liveFg?.dropped).toBe(2); // the serial-less row and the null

    // The all-malformed line still landed, degraded rather than discarded.
    const degraded = await sql<{ qty_balance: string; th: string | null }[]>`
      select qty_balance::text, th::text from erp_so_line where id = 'SOL-2007'
    `;
    expect(degraded[0]?.qty_balance).toBe("0");
    expect(degraded[0]?.th).toBeNull();
  });

  it("survives a total ERP outage without throwing, and leaves the mirror intact", async () => {
    await run(sql);
    const mirrorBefore = await mirrorSnapshot(sql);

    faults = { status: { "so_header:1": 500, "so_line:1": 500, "live_fg:1": 500 } };
    const result = await run(sql);

    expect(result.started).toBe(true); // resolved, did not reject
    expect(result.tables.every((t) => !t.ok)).toBe(true);
    expect(await mirrorSnapshot(sql)).toEqual(mirrorBefore);

    const states = await syncStateRows(sql);
    expect(states.every((s) => s.running === false)).toBe(true);
    expect(states.every((s) => (s.last_error ?? "").length > 0)).toBe(true);
  });

  it("refuses to start a second run while one is in flight (§4.2 manual kick)", async () => {
    const first = run(sql);
    const second = await runErpSyncOnce({ db: sql, pageSize: PAGE_SIZE, intervalMs: 60_000, log: silentLog });
    expect(second.started).toBe(false);
    expect(second.skipped).toBe("in_flight");
    await first;
  });

  it("reclaims a `running` row abandoned by a crashed process (crash safety)", async () => {
    // A SIGKILL mid-run leaves running=true forever. Without reclamation that
    // single crash would disable sync for the life of the deployment.
    // The interval here is 60s, so the staleness threshold is 3 minutes.
    await sql`update erp_sync_state set running = true, last_ok_at = now() - interval '1 hour', last_error_at = null`;

    const abandoned = await run(sql);
    expect(abandoned.started).toBe(true); // no activity for an hour ⇒ reclaimed

    await sql`update erp_sync_state set running = true, last_ok_at = now(), last_error_at = null`;
    const held = await run(sql); // fresh activity ⇒ a live run holds it
    expect(held.started).toBe(false);
    expect(held.skipped).toBe("locked");
    await sql`update erp_sync_state set running = false`;
  });

  it("never lets SELARAS_TOKEN reach a log line, on the happy path or the failure path", async () => {
    const spies = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    const emitted: string[] = [];
    const capturingLog = {
      info: (m: string) => emitted.push(m),
      warn: (m: string) => emitted.push(m),
      error: (m: string) => emitted.push(m),
    };
    try {
      await run(sql, capturingLog); // happy path (drops, shape notices)
      faults = { status: { "so_line:1": 503 }, garbage: { "live_fg:1": `401 Unauthorized: Bearer ${TOKEN}` } };
      await resetCursors(sql);
      await run(sql, capturingLog); // failure paths, including an echoed credential

      for (const spy of Object.values(spies)) {
        for (const call of spy.mock.calls) {
          expect(JSON.stringify(call)).not.toContain(TOKEN);
        }
      }
      expect(emitted.length).toBeGreaterThan(0);
      for (const line of emitted) expect(line).not.toContain(TOKEN);

      const states = await syncStateRows(sql);
      for (const s of states) expect(s.last_error ?? "").not.toContain(TOKEN);
    } finally {
      for (const spy of Object.values(spies)) spy.mockRestore();
    }
  });
});

// ── 4. The disabled path (invariant §7.7) ────────────────────────────────────

describe("startErpSync — disabled without an ERP or a database (§5)", () => {
  it("warns exactly once and starts no interval when SELARAS_BASE_URL is unset", async () => {
    vi.resetModules();
    const saved = process.env["SELARAS_BASE_URL"];
    delete process.env["SELARAS_BASE_URL"];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const setInterval = vi.spyOn(globalThis, "setInterval");
    try {
      const isolated = await import("../src/erp/syncWorker.js");
      expect(() => isolated.startErpSync()).not.toThrow();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]?.[0])).toContain("SELARAS_BASE_URL");
      expect(setInterval).not.toHaveBeenCalled();
    } finally {
      setInterval.mockRestore();
      warn.mockRestore();
      if (saved !== undefined) process.env["SELARAS_BASE_URL"] = saved;
      vi.resetModules();
    }
  });

  it("runErpSyncOnce() is a no-op rather than a crash when nothing is configured", async () => {
    vi.resetModules();
    const saved = process.env["SELARAS_BASE_URL"];
    delete process.env["SELARAS_BASE_URL"];
    try {
      const isolated = await import("../src/erp/syncWorker.js");
      const result = await isolated.runErpSyncOnce();
      expect(result.started).toBe(false);
      expect(result.skipped).toBe("disabled");
    } finally {
      if (saved !== undefined) process.env["SELARAS_BASE_URL"] = saved;
      vi.resetModules();
    }
  });
});
