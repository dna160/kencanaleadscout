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
  adaptWarnaRow,
  buildPageUrl,
  fetchPage,
  parseErpNumber,
  readEnvelope,
  redactSecrets,
  resetShapeNotices,
  buildColumnDiagnostic,
  describeColumnDiagnostic,
} = clientMod;
const { runErpSyncOnce, recomputeSkuKeys } = workerMod;
const { canonicalSkuKey } = skuMod;

type SelarasTable = clientMod.SelarasTable;

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** warna + so_header + so_line + live_fg — every table a full re-sync clears and re-pulls. */
const SYNC_TABLE_COUNT = clientMod.SYNC_TABLES.length;

function loadFixture(name: string): unknown[] {
  const parsed = JSON.parse(readFileSync(join(FIXTURE_DIR, name), "utf8")) as { rows: unknown[] };
  return parsed.rows;
}

const FIXTURES: Record<SelarasTable, unknown[]> = {
  warna: loadFixture("selaras-warna.json"),
  so_header: loadFixture("selaras-so-header.json"),
  so_line: loadFixture("selaras-so-line.json"),
  live_fg: loadFixture("selaras-live-fg.json"),
};

/**
 * SO headers whose date columns are broken in every way the real ERP produces
 * them. Kept out of `selaras-so-header.json` on purpose: the other tests assert
 * exact mirror counts off that file, and these rows are served through
 * `faults.rows` only by the tests that want them.
 *
 * `0000-00-00 00:00:00` is MySQL's zero date for an unset column. It is what
 * aborted so_header in production: it matches a 'YYYY-MM-DD' shape check
 * perfectly, but `new Date('0000-00-00')` is Invalid Date, and postgres.js
 * serializes a `date`/`timestamptz` parameter with `.toISOString()` — which
 * throws `RangeError: Invalid time value` during Bind, inside the page
 * transaction, aborting the entire table pass and pinning its cursor forever.
 */
const MYSQL_ZERO_DATE = "0000-00-00 00:00:00";

const BAD_DATE_HEADERS: unknown[] = [
  {
    tbl_1202_SOSalesOrderNID_id: "SOH-OK-1",
    so_number: "SO/2026/09/0301",
    customer_name_text: "PT Tanggal Benar",
    sales_name_text: "Budi",
    po_date: "2026-08-01",
    status_order: "Open",
    deleted_at: null,
    updated_at: "2026-09-03T01:00:00Z",
  },
  {
    // THE PRODUCTION CULPRIT, in both date columns at once.
    tbl_1202_SOSalesOrderNID_id: "SOH-ZERO",
    so_number: "SO/2011/01/0001",
    customer_name_text: "PT Tanggal Nol",
    sales_name_text: "Sari",
    po_date: "0000-00-00",
    status_order: "Open",
    deleted_at: null,
    updated_at: MYSQL_ZERO_DATE,
  },
  {
    tbl_1202_SOSalesOrderNID_id: "SOH-NULL-TS",
    so_number: "SO/2026/09/0302",
    customer_name_text: "PT Tanpa Updated",
    sales_name_text: "Dewi",
    po_date: "2026-08-02",
    status_order: "Open",
    deleted_at: null,
    updated_at: null,
  },
  {
    tbl_1202_SOSalesOrderNID_id: "SOH-EMPTY",
    so_number: "SO/2026/09/0303",
    customer_name_text: "PT Kosong",
    sales_name_text: "Dewi",
    po_date: "",
    status_order: "Open",
    deleted_at: null,
    updated_at: "",
  },
  {
    tbl_1202_SOSalesOrderNID_id: "SOH-GARBAGE",
    so_number: "SO/2026/09/0304",
    customer_name_text: "PT Tanggal Ngawur",
    sales_name_text: "Budi",
    po_date: "tanggal tidak diketahui",
    status_order: "Open",
    deleted_at: null,
    updated_at: "31 Februari kemarin",
  },
  {
    tbl_1202_SOSalesOrderNID_id: "SOH-OK-2",
    so_number: "SO/2026/09/0305",
    customer_name_text: "PT Tanggal Benar Juga",
    sales_name_text: "Sari",
    po_date: "2026-08-03",
    status_order: "Open",
    deleted_at: null,
    updated_at: "2026-09-04T02:00:00Z",
  },
];

/** The newest VALID `updated_at` above — the only place the cursor may land. */
const BAD_DATE_HEADERS_MAX_VALID = new Date("2026-09-04T02:00:00Z");

/** The same rows with every timestamp broken: a page with nothing to advance to. */
const ALL_BAD_DATE_HEADERS: unknown[] = [
  {
    tbl_1202_SOSalesOrderNID_id: "SOH-ALLBAD-1",
    so_number: "SO/2011/01/0002",
    customer_name_text: "PT Semua Nol",
    po_date: "0000-00-00",
    status_order: "Open",
    deleted_at: null,
    updated_at: MYSQL_ZERO_DATE,
  },
  {
    tbl_1202_SOSalesOrderNID_id: "SOH-ALLBAD-2",
    so_number: "SO/2011/01/0003",
    customer_name_text: "PT Semua Ngawur",
    po_date: "31/02/2020",
    status_order: "Open",
    deleted_at: null,
    updated_at: "bukan tanggal",
  },
];

/** ERP table name (what the URL carries) → our logical table name. */
const ERP_TABLE_TO_LOGICAL: Record<string, SelarasTable> = {
  tbl_1228_DBRMWarnaID: "warna",
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
// It answers with the VERIFIED envelope (2026-09-11) for every table:
//   `{ success, table, meta: { count, total, total_pages, page, limit, offset,
//      order_by, order_dir, filters }, data: [...] }`
// The tolerated alternatives (bare array, `results`/`total`, …) are still
// covered, as unit tests of readEnvelope() rather than as pretend ERP behaviour.

interface ErpFault {
  /** `${table}:${page}` → HTTP status to answer with instead of data. */
  status?: Record<string, number>;
  /** `${table}:${page}` → answer 200 with a non-JSON body (a login page, say). */
  garbage?: Record<string, string>;
  /** `${table}:${page}` → answer 200 with `success: false` (FIX 5). */
  unsuccessful?: Record<string, true>;
  /** `${table}:${page}` → answer with an envelope the verified API never sends. */
  shape?: Record<string, "bare_array">;
  /**
   * Serve a DIFFERENT row set for a table, instead of its on-disk fixture. Used
   * by the bad-date tests, which need rows that the shared fixtures must not
   * carry — every other test asserts exact mirror counts off those fixtures.
   */
  rows?: Partial<Record<SelarasTable, unknown[]>>;
}

let faults: ErpFault = {};
let requestLog: string[] = [];
/** Headers of the most recent request, lower-cased — the auth tests read these. */
let lastRequestHeaders: Record<string, string> = {};

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
  if (faults.unsuccessful?.[key]) {
    return {
      statusCode: 200,
      data: { success: false, table: erpTable, message: "refused", meta: {}, data: [] },
      headers: { "content-type": "application/json" },
    };
  }
  const garbage = faults.garbage?.[key];
  if (garbage !== undefined) {
    return { statusCode: 200, data: garbage, headers: { "content-type": "text/html" } };
  }

  const since = url.searchParams.get("updated_at__gte");
  const sinceMs = since ? new Date(since).getTime() : Number.NEGATIVE_INFINITY;

  // `__gte` + ascending `updated_at`, exactly as PRD §4 specifies (A2).
  const matching = (faults.rows?.[table] ?? FIXTURES[table])
    .filter((r) => rawUpdatedAtMs(r) >= sinceMs)
    .sort((a, b) => rawUpdatedAtMs(a) - rawUpdatedAtMs(b));
  const slice = matching.slice((page - 1) * limit, page * limit);

  const headers = { "content-type": "application/json" };
  if (faults.shape?.[key] === "bare_array") {
    return { statusCode: 200, data: slice, headers };
  }
  return {
    statusCode: 200,
    data: {
      success: true,
      table: erpTable,
      meta: {
        count: slice.length,
        total: matching.length,
        total_pages: Math.max(1, Math.ceil(matching.length / limit)),
        page,
        limit,
        offset: (page - 1) * limit,
        order_by: url.searchParams.get("order_by"),
        order_dir: url.searchParams.get("order_dir"),
        filters: {},
      },
      data: slice,
    },
    headers,
  };
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
      lastRequestHeaders = {};
      const raw = (opts.headers ?? {}) as Record<string, unknown>;
      for (const [k, v] of Object.entries(raw)) lastRequestHeaders[k.toLowerCase()] = String(v);
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
  lastRequestHeaders = {};
});

// ── 1. The client's assumptions, isolated ────────────────────────────────────

describe("selarasClient — URL contract (VERIFIED 2026-09-11)", () => {
  it("reads rows from <base>/table/{table}, not <base>/{table}", () => {
    // The pre-documentation client sent GET <base>/{table}, which would have
    // 404'd on the very first real request.
    for (const [table, erpTable] of [
      ["warna", "tbl_1228_DBRMWarnaID"],
      ["so_header", "tbl_1202_SOSalesOrderNID"],
      ["so_line", "tbl_1203_SOSalesOrderDetailNID"],
      ["live_fg", "tbl_1210_STLiveFGMX"],
    ] as const) {
      const url = new URL(buildPageUrl(table, { since: null, page: 1, limit: 10 }));
      expect(url.pathname, table).toBe(`/api/table/${erpTable}`);
    }
  });

  it("builds the documented query string, with __gte so no boundary row is skipped", () => {
    const url = new URL(buildPageUrl("so_line", { since: new Date("2026-09-01T02:00:00Z"), page: 3, limit: 500 }));
    expect(url.pathname).toBe("/api/table/tbl_1203_SOSalesOrderDetailNID");
    // FIX A — the documented grammar is `YYYY-MM-DD HH:mm:ss` in WIB (UTC+7),
    // and the request carries the cursor minus STOCK_SYNC_LOOKBACK_MINUTES.
    // 02:00Z − 12h = 14:00Z the previous day = 21:00 WIB.
    expect(url.searchParams.get("updated_at__gte")).toBe("2026-08-31 21:00:00");
    expect(url.searchParams.get("order_by")).toBe("updated_at");
    expect(url.searchParams.get("order_dir")).toBe("asc");
    expect(url.searchParams.get("limit")).toBe("500");
    expect(url.searchParams.get("page")).toBe("3");
  });

  it("sends the cursor in the documented WIB grammar, never ISO-8601 (FIX A)", () => {
    // The silent failure this prevents: the spec documents WIB datetimes and says
    // nothing about ISO-8601. An ERP that parsed `...T03:00:00.000Z` and then
    // DISCARDED the offset would read it as 03:00 WIB, leaving the cursor SEVEN
    // HOURS ahead. Every row updated in that window is skipped, and a cursor only
    // moves forward, so no later run ever revisits them. Nothing logs.
    const url = new URL(buildPageUrl("so_line", { since: new Date("2026-09-01T02:00:00Z"), page: 1, limit: 10 }));
    const cursor = url.searchParams.get("updated_at__gte") ?? "";
    expect(cursor).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(cursor).not.toContain("T");
    expect(cursor).not.toContain("Z");
    // And it denotes the instant we meant, read as WIB.
    expect(Date.parse(`${cursor.replace(" ", "T")}+07:00`)).toBe(
      new Date("2026-09-01T02:00:00Z").getTime() - 720 * 60_000,
    );
  });

  it("subtracts a lookback wide enough to absorb a misread timezone (FIX A)", async () => {
    const { config } = await import("../src/config.js");
    // 12 hours by default, and the size is the point: it must comfortably exceed
    // the 7-hour WIB offset, which is the specific failure it exists to absorb.
    expect(config.stock.syncLookbackMinutes).toBe(720);
    expect(config.stock.syncLookbackMinutes).toBeGreaterThan(7 * 60);
    // Re-fetching is free: every write is an idempotent upsert keyed on the PK,
    // which the idempotency test below proves over a whole replayed window.
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

  it("says nothing when the ERP answers the verified shape", async () => {
    resetShapeNotices();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await fetchPage("live_fg", { since: null, page: 1, limit: PAGE_SIZE });
      expect(warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("envelope"))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it("logs an unexpected shape ONCE, clearly enough to correct the reader from the log line", async () => {
    resetShapeNotices();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // A body the verified envelope would never produce: a bare array. Two
      // fetches, one notice — a warning every three minutes is a warning nobody
      // reads.
      faults = { shape: { "live_fg:1": "bare_array", "live_fg:2": "bare_array" } };
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

describe("auth — Selaras issues a KEY + TOKEN pair, not a bearer credential", () => {
  const KEY = "kcn_testkey_0000000000000000000000";
  const TOK = "testtoken_1111111111111111111111111111";

  it("defaults each placement to ITS OWN verified credential names", async () => {
    // The bug: header mode lower-cased whatever SELARAS_KEY_PARAM held and sent
    // `secret_key:` as a header name. Verified 2026-09-11, the headers are
    // X-Secret-Key / X-Secret-Token and the QUERY params are secret_key /
    // secret_token — two different names, so one default cannot serve both.
    const { config } = await import("../src/config.js");
    expect(config.selarasKeyHeader).toBe("x-secret-key");
    expect(config.selarasTokenHeader).toBe("x-secret-token");
    expect(config.selarasKeyParam).toBe("secret_key");
    expect(config.selarasTokenParam).toBe("secret_token");
  });

  it("sends the credential pair as X-Secret-Key / X-Secret-Token headers", async () => {
    // Read off the wire: the fake ERP records the headers it was called with.
    lastRequestHeaders = {};
    const saved = { key: process.env["SELARAS_SECRET_KEY"], tok: process.env["SELARAS_SECRET_TOKEN"] };
    vi.resetModules();
    process.env["SELARAS_SECRET_KEY"] = KEY;
    process.env["SELARAS_SECRET_TOKEN"] = TOK;
    try {
      const isolated = await import("../src/erp/selarasClient.js");
      await isolated.fetchPage("so_header", { since: null, page: 1, limit: 2, retryDelayMs: 0 });
      expect(lastRequestHeaders["x-secret-key"]).toBe(KEY);
      expect(lastRequestHeaders["x-secret-token"]).toBe(TOK);
      // …and never as the query-param spelling, which would be a 401.
      expect(lastRequestHeaders["secret_key"]).toBeUndefined();
      expect(lastRequestHeaders["secret_token"]).toBeUndefined();
    } finally {
      if (saved.key === undefined) delete process.env["SELARAS_SECRET_KEY"];
      else process.env["SELARAS_SECRET_KEY"] = saved.key;
      if (saved.tok === undefined) delete process.env["SELARAS_SECRET_TOKEN"];
      else process.env["SELARAS_SECRET_TOKEN"] = saved.tok;
      vi.resetModules();
    }
  });

  it("redacts the header names' values too, not just the query params", async () => {
    const { redactSecrets } = await import("../src/erp/selarasClient.js");
    const out = redactSecrets(`X-Secret-Key: ${KEY}; x-secret-token: ${TOK}`);
    expect(out).not.toContain(KEY);
    expect(out).not.toContain(TOK);
  });

  it("never puts the credential pair on the URL in the default header mode", async () => {
    const { buildPageUrl } = await import("../src/erp/selarasClient.js");
    const url = buildPageUrl("so_line", { since: null, page: 1, limit: 10 });
    expect(url).not.toContain(KEY);
    expect(url).not.toContain(TOK);
    expect(url).not.toContain("secret_key");
    expect(url).not.toContain("secret_token");
  });

  it("redacts the credential pair out of a URL, an error and a JSON blob", async () => {
    const { redactSecrets } = await import("../src/erp/selarasClient.js");
    const samples = [
      `https://erp.example.com/t?secret_key=${KEY}&secret_token=${TOK}`,
      `{"secret_key":"${KEY}","secret_token":"${TOK}"}`,
      `401 Unauthorized: secret_token=${TOK}`,
    ];
    for (const raw of samples) {
      const out = redactSecrets(raw);
      expect(out, raw).not.toContain(KEY);
      expect(out, raw).not.toContain(TOK);
    }
  });
});

describe("adapters — one per table, on the verified column names", () => {
  it("reads the documented {table}_id primary key first (FIX 4)", () => {
    expect(adaptSoHeaderRow(FIXTURES.so_header[0])?.id).toBe("SOH-1001");
    expect(adaptSoLineRow(FIXTURES.so_line[0])?.id).toBe("SOL-2001");
    // FIX B: the PRIMARY KEY is the ERP row id; `sn_fg` keeps the roll serial.
    expect(adaptLiveFgRow(FIXTURES.live_fg[0])?.erp_row_id).toBe("FG-0001");
    expect(adaptWarnaRow(FIXTURES.warna[0])?.id).toBe("4");
    // The table-qualified name wins over a bare `id` carrying something else.
    const both = adaptSoLineRow({ tbl_1203_SOSalesOrderDetailNID_id: "REAL", id: "LEGACY" });
    expect(both?.id).toBe("REAL");
    // …and the old spellings still work, so a mirror seeded before the remap
    // keys the same way.
    expect(adaptSoLineRow({ id: "LEGACY" })?.id).toBe("LEGACY");
  });

  it("adapts the documented fields, whatever casing they arrive in", () => {
    const header = adaptSoHeaderRow(FIXTURES.so_header[0]);
    expect(header?.id).toBe("SOH-1001");
    expect(header?.customer_name_text).toBe("PT Sinar Mandiri");

    const line = adaptSoLineRow(FIXTURES.so_line[0]);
    expect(line?.qty_balance).toBe(319);
    expect(line?.estimate_delivery).toBe("2099-09-20");
    expect(line?.brand_text).toBe("ACP Kencana");
    expect(line?.warna_text).toBe("BLACK GALAXY");

    const fg = adaptLiveFgRow(FIXTURES.live_fg[0]);
    expect(fg?.qty).toBe(2084);
    expect(fg?.lokasi).toBe("GD-01");
    expect(fg?.kode_barang).toBe("ACP-4MM"); // display only, never in the key

    // Casing tolerance is a property of the adapters, not of the fixtures.
    const camel = adaptSoLineRow({
      tbl_1203_SOSalesOrderDetailNID_id: "X", brand: "ACP", warna: 4,
      thAluSkin: 0.3, TotalThicknessAcp: 4, P: 4880, l: 1220,
    });
    expect(camel?.th).toBe(0.3);
    expect(camel?.th_panel).toBe(4);
    expect(camel?.p).toBe(4880);
  });

  it("maps each side's OWN thickness columns onto the same two (the 2026-09-11 fix)", () => {
    // tbl_1203 has th_alu_skin + total_thickness_acp; tbl_1210 has th + t.
    const line = adaptSoLineRow(FIXTURES.so_line[0]);
    const fg = adaptLiveFgRow(FIXTURES.live_fg[0]);
    expect(line?.th).toBe(0.3);       // ← th_alu_skin
    expect(line?.th_panel).toBe(4);   // ← total_thickness_acp
    expect(fg?.th).toBe(0.3);         // ← th
    expect(fg?.th_panel).toBe(4);     // ← t
    // And the SO side must NOT pick up a bare `th`, which tbl_1203 does not
    // have — a fallback probe for it would resurrect the wrong-column bug.
    const sneaky = adaptSoLineRow({ tbl_1203_SOSalesOrderDetailNID_id: "X", th: 9.9, t: 9.9 });
    expect(sneaky?.th).toBeNull();
    expect(sneaky?.th_panel).toBeNull();
  });

  it("computes sku_key through canonicalSkuKey(), never its own copy (§7.4)", () => {
    const line = adaptSoLineRow(FIXTURES.so_line[0]);
    const fg = adaptLiveFgRow(FIXTURES.live_fg[0]);
    const expected = canonicalSkuKey({ brand: "ACP", warna: "4", th: 0.3, th_panel: 4, p: 4880, l: 1220 });
    expect(expected).toBe("ACP|4|0.3|4|4880|1220");
    expect(line?.sku_key).toBe(expected);
    expect(fg?.sku_key).toBe(expected);
    // THE assertion of this whole remap: demand and supply land on the SAME key.
    // Under the v1 composition the SO line keyed as '-|4|-|4880|1220' and nothing
    // could ever match, so every SKU read as fully promiseable.
    expect(line?.sku_key).toBe(fg?.sku_key);
  });

  it("carries the soft-delete marker every table has (FIX 6)", () => {
    expect(adaptSoLineRow(FIXTURES.so_line[0])?.deleted_at).toBeNull();
    expect(adaptSoLineRow(FIXTURES.so_line[9])?.deleted_at).toBeInstanceOf(Date);
    expect(adaptLiveFgRow(FIXTURES.live_fg[8])?.deleted_at).toBeInstanceOf(Date);
    expect(adaptSoHeaderRow(FIXTURES.so_header[4])?.deleted_at).toBeInstanceOf(Date);
    expect(adaptWarnaRow(FIXTURES.warna[2])?.deleted_at).toBeInstanceOf(Date);
  });

  it("reads the colour master, keeping the id AND a numeric form of it (FIX 7)", () => {
    const w = adaptWarnaRow(FIXTURES.warna[0]);
    expect(w?.id).toBe("4");
    expect(w?.code_num).toBe(4);
    expect(w?.rm_warna).toBe("BLACK GALAXY");
    expect(adaptWarnaRow(FIXTURES.warna[3])).toBeNull(); // no id ⇒ unkeyable
  });

  it("normalizes messy-but-UNAMBIGUOUS values ('0.30', '4880.00', ' 004 ', dd/mm/yyyy) onto that same key", () => {
    const messy = adaptSoLineRow(FIXTURES.so_line[1]);
    const clean = adaptSoLineRow(FIXTURES.so_line[0]);
    expect(messy?.sku_key).toBe(clean?.sku_key);
    expect(messy?.qty_balance).toBe(1810);
    expect(messy?.estimate_delivery).toBe("2020-05-11");
  });

  it("drops an unkeyable row instead of throwing", () => {
    expect(adaptSoHeaderRow(FIXTURES.so_header[3])).toBeNull(); // no id
    expect(adaptLiveFgRow(FIXTURES.live_fg[4])).toBeNull(); // no primary key
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

// ── ST-R5.3 — the column diagnostic ──────────────────────────────────────────
//
// THE OPEN QUESTION IT EXISTS TO CLOSE. Production reports 97.4% of live
// commitment lines matching NO stock row, and the two sides fail in mirror
// image: every demand key ends `|-|-` (no `p`/`l`) and every stock key carries
// `|0|0|` in the two thickness positions. Each side is missing precisely the
// segments the other side has, which is a column-mapping failure — but THREE
// mappings fit the evidence and the ERP is unreachable from here:
//
//   (a) the API returns different NAMES than the verified documentation lists;
//   (b) it returns them NESTED inside another object;
//   (c) it returns NULL for these rows — an ERP data problem, not a mapping one.
//
// These fixtures are deliberately NOT the documented column list: each one is
// one of those three hypotheses made concrete, and the assertions are that the
// diagnostic NAMES what is really on the wire instead of repeating what the
// documentation claims. Guessing between (a), (b) and (c) is exactly what
// produced the v1 key that matched nothing.

/** (a) + (b): the FG table under different names, with `p`/`l` nested. */
const DRIFTED_FG_ROW = {
  tbl_1210_STLiveFGMX_id: "FG-DRIFT-1",
  sn_fg: "FG-AAA-0001",
  kode_barang: "ACP-4MM",
  brand: "10",
  warna: "141",
  // NOT `th` and NOT `t` — the two segments production sees as `0`.
  thickness_alu_skin: "0.3",
  total_thickness: "4",
  // NOT `p` / `l` at top level: one level down, which no adapter probe reaches.
  dimensi: { p: 4880, l: 1220 },
  qty: "12",
  updated_at: "2026-09-05T00:00:00Z",
  deleted_at: null,
};

/** (c): the documented names ARE there, and carry null for these rows. */
const NULL_SEGMENT_FG_ROW = {
  tbl_1210_STLiveFGMX_id: "FG-NULL-1",
  brand: "10",
  warna: "141",
  th: null,
  t: null,
  p: 4880,
  l: 1220,
  qty: 3,
  deleted_at: null,
};

/** The stock side exactly as production reports it: a REAL zero, not an absence. */
const ZERO_SEGMENT_FG_ROW = {
  tbl_1210_STLiveFGMX_id: "FG-ZERO-1",
  brand: "10",
  warna: "141",
  th: 0,
  t: "0",
  p: 1000,
  l: 500,
  qty: 3,
  deleted_at: null,
};

/** The demand side as production reports it: `p` and `l` simply are not there. */
const NO_PL_SO_ROW = {
  tbl_1203_SOSalesOrderDetailNID_id: "SOL-DRIFT-1",
  brand: "1",
  warna: "172",
  th_alu_skin: "0.5",
  total_thickness_acp: "4",
  customer_name_text: "PT Rahasia Sekali",
  harga_satuan: "1250000",
  qty_balance: 7,
};

function probeOf(d: clientMod.ColumnDiagnostic, segment: string): clientMod.SegmentProbe {
  const hit = d.segments.find((x) => x.segment === segment);
  if (!hit) throw new Error(`no probe for ${segment}`);
  return hit;
}

describe("column diagnostic — names the REAL wire keys, not the documented ones", () => {
  it("lists the complete sorted key list actually present on the row", () => {
    const d = buildColumnDiagnostic("live_fg", DRIFTED_FG_ROW);
    expect(d).not.toBeNull();
    // Sorted, complete, and spelled the way the WIRE spells them. `dimensi` is
    // rendered with its child names because "returns them nested" is one of the
    // three hypotheses and is otherwise invisible.
    expect(d?.keys).toEqual([
      "brand",
      "deleted_at",
      "dimensi{l,p}",
      "kode_barang",
      "qty",
      "sn_fg",
      "tbl_1210_STLiveFGMX_id",
      "thickness_alu_skin",
      "total_thickness",
      "updated_at",
      "warna",
    ]);
    expect(d?.keysTruncated).toBe(false);
    expect(d?.erpTable).toBe("tbl_1210_STLiveFGMX");
    expect(d?.side).toBe("live_fg");
  });

  it("reports every unmatched segment, with the probe names it actually tried", () => {
    const d = buildColumnDiagnostic("live_fg", DRIFTED_FG_ROW);
    expect(d?.unmatched).toEqual(["th", "th_panel", "p", "l"]);

    // The probe list is READ FROM SKU_SEGMENT_SOURCES, so it cannot drift from
    // the mapping the adapter is really running.
    expect(probeOf(d!, "th").probes).toEqual(skuMod.SKU_SEGMENT_SOURCES.th.live_fg);
    expect(probeOf(d!, "th").probes).toEqual(["th"]);
    expect(probeOf(d!, "th_panel").probes).toEqual(["t"]);
    expect(probeOf(d!, "p").probes).toEqual(["p"]);

    // Absent ⇒ the segment contributes '-', which is what the key shows.
    for (const name of ["th", "th_panel", "p", "l"]) {
      expect(probeOf(d!, name).status, name).toBe("absent");
      expect(probeOf(d!, name).matched, name).toBeNull();
      expect(probeOf(d!, name).raw, name).toBeNull();
      expect(probeOf(d!, name).normalized, name).toBe("-");
    }
    // …and the segments that DID match name the wire key and show both values.
    expect(probeOf(d!, "brand")).toMatchObject({ status: "matched", matched: "brand", raw: "10", normalized: "10" });
    expect(probeOf(d!, "warna")).toMatchObject({ status: "matched", matched: "warna", normalized: "141" });

    // The adapter agrees with the diagnostic, which is the point of both.
    expect(adaptLiveFgRow(DRIFTED_FG_ROW)?.sku_key).toBe("10|141|-|-|-|-");
  });

  it("separates 'no such key' from 'key present, value null' (hypothesis c)", () => {
    const d = buildColumnDiagnostic("live_fg", NULL_SEGMENT_FG_ROW);
    expect(probeOf(d!, "th").status).toBe("null");
    expect(probeOf(d!, "th").matched).toBe("th"); // the column EXISTS
    expect(probeOf(d!, "th").normalized).toBe("-");
    expect(probeOf(d!, "th_panel").status).toBe("null");
    // Same '-' in the key, completely different cause — and the log says which.
    const text = describeColumnDiagnostic(d!);
    expect(text).toContain("key 'th' EXISTS but its value is null");
    expect(text).not.toContain("NO SUCH KEY on this row (under any casing) → \"-\"\n    th_panel");
  });

  it("separates a REAL zero from an absent segment (the 0-vs-'-' question)", () => {
    // This is the FG side exactly as production reports it. A zero here is a
    // value that was PRESENT and read as zero — NOT a column we failed to find.
    // The two are different facts and the diagnostic must not blur them.
    const d = buildColumnDiagnostic("live_fg", ZERO_SEGMENT_FG_ROW);
    expect(probeOf(d!, "th")).toMatchObject({ status: "matched", matched: "th", raw: "0", normalized: "0" });
    expect(probeOf(d!, "th_panel")).toMatchObject({ status: "matched", matched: "t", raw: "0", normalized: "0" });
    expect(d?.unmatched).toEqual([]);
    expect(adaptLiveFgRow(ZERO_SEGMENT_FG_ROW)?.sku_key).toBe("10|141|0|0|1000|500");
  });

  it("shows the demand side losing p and l, which is what ends every key '|-|-'", () => {
    const d = buildColumnDiagnostic("so_line", NO_PL_SO_ROW);
    expect(d?.side).toBe("so_line");
    expect(d?.unmatched).toEqual(["p", "l"]);
    expect(probeOf(d!, "th")).toMatchObject({ status: "matched", matched: "th_alu_skin", normalized: "0.5" });
    expect(probeOf(d!, "th_panel")).toMatchObject({ status: "matched", matched: "total_thickness_acp" });
    expect(adaptSoLineRow(NO_PL_SO_ROW)?.sku_key).toBe("1|172|0.5|4|-|-");
  });

  it("logs KEY NAMES and identity values only — never row content (§7.9)", () => {
    const text = describeColumnDiagnostic(buildColumnDiagnostic("so_line", NO_PL_SO_ROW)!);
    // The column NAMES are the diagnostic's whole payload and must be there…
    expect(text).toContain("customer_name_text");
    expect(text).toContain("harga_satuan");
    // …but not one of their VALUES. Rows carry customers and prices.
    expect(text).not.toContain("PT Rahasia Sekali");
    expect(text).not.toContain("1250000");
    // Only the six identity segments are ever sampled.
    expect(text).toContain('raw="0.5"');
  });

  it("redacts a sampled value, and never prints a nested object's contents", () => {
    const withSecret = { ...NULL_SEGMENT_FG_ROW, th: `x${TOKEN}x`, t: { inner: "PT Rahasia", nested: 1 } };
    const text = describeColumnDiagnostic(buildColumnDiagnostic("live_fg", withSecret)!);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain("PT Rahasia");
    expect(text).toContain("t{inner,nested}"); // the shape, by name, and nothing else
  });

  it("caps a sampled value rather than spilling a long one into the log", () => {
    const long = "9".repeat(500);
    const d = buildColumnDiagnostic("live_fg", { ...ZERO_SEGMENT_FG_ROW, th: long });
    expect((probeOf(d!, "th").raw ?? "").length).toBeLessThanOrEqual(40);
  });

  it("an ABSENT numeric segment is '-', never 0 — they are different facts", () => {
    // The production symptom is `|0|0|` in the two FG thickness positions. That
    // is NOT what a column we failed to read produces: EVERY way of failing to
    // read a numeric segment already yields '-', matching the SQL twin
    // (`sqlNumericSegment`: `when <arg> is null then '-'`). So a `0` in a stored
    // key is evidence of a value that WAS present and WAS zero — a different
    // problem from a missing column, and exactly the distinction the
    // diagnostic's matched/null/absent split exists to report.
    const base = { tbl_1210_STLiveFGMX_id: "FG-Z", brand: "10", warna: "141", p: 1000, l: 500 };
    const absentish: readonly [string, unknown][] = [
      ["absent", undefined],
      ["null", null],
      ["empty string", ""],
      ["boolean false", false],
      ["separator-ambiguous '0.000'", "0.000"],
      ["unreadable text", "tidak ada"],
    ];
    for (const [name, value] of absentish) {
      const row = value === undefined ? base : { ...base, th: value, t: value };
      expect(adaptLiveFgRow(row)?.sku_key, name).toBe("10|141|-|-|1000|500");
    }
    // …and only a value that really IS zero renders as 0.
    expect(adaptLiveFgRow({ ...base, th: 0, t: "0.00" })?.sku_key).toBe("10|141|0|0|1000|500");
  });

  it("says plainly that warna and so_header carry no sku_key segment", () => {
    for (const table of ["warna", "so_header"] as const) {
      const d = buildColumnDiagnostic(table, FIXTURES[table][0]);
      expect(d?.side).toBeNull();
      expect(d?.segments).toEqual([]);
      expect(d?.keys.length).toBeGreaterThan(0);
      expect(describeColumnDiagnostic(d!)).toContain("contributes no segment to the key");
    }
  });

  it("is total: a non-object row yields null instead of throwing", () => {
    for (const raw of [null, undefined, 42, "a string", [1, 2, 3]]) {
      expect(buildColumnDiagnostic("live_fg", raw)).toBeNull();
    }
  });

  it("is attached to the FIRST page only — once per table per run, not per page", async () => {
    // live_fg has 9 fixture rows at a page size of 2, so a real run reads five
    // pages. Only one of them may carry a diagnostic.
    const carried: number[] = [];
    for (let page = 1; page <= 5; page += 1) {
      const res = await fetchPage("live_fg", { since: null, page, limit: PAGE_SIZE });
      expect(res.ok).toBe(true);
      if (res.ok && res.page.columnDiagnostic !== null) carried.push(page);
    }
    expect(carried).toEqual([1]);
  });

  it("is off, and costs nothing, when STOCK_SYNC_DIAGNOSE_COLUMNS=false", async () => {
    vi.resetModules();
    process.env["STOCK_SYNC_DIAGNOSE_COLUMNS"] = "false";
    try {
      const isolated = await import("../src/erp/selarasClient.js");
      const res = await isolated.fetchPage("live_fg", { since: null, page: 1, limit: PAGE_SIZE });
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.page.columnDiagnostic).toBeNull();
        expect(res.page.rows.length).toBeGreaterThan(0); // …and the rows still arrive
      }
    } finally {
      delete process.env["STOCK_SYNC_DIAGNOSE_COLUMNS"];
      vi.resetModules();
    }
  });
});

describe("unreadable dates are refused at the adapter, never written through", () => {
  /**
   * The production defect, at the layer that caused it.
   *
   * `tbl_1202_SOSalesOrderNID.po_date` carries MySQL's zero date on older rows.
   * `'0000-00-00'` matches a 'YYYY-MM-DD' shape test, so it used to be passed
   * through verbatim as a `date` parameter — and postgres.js serializes a `date`
   * with `(x instanceof Date ? x : new Date(x)).toISOString()`, which throws
   * `RangeError: Invalid time value` on an Invalid Date. That RangeError landed
   * inside `commitPage()`'s transaction and aborted the whole table pass.
   *
   * The rule now: a date is accepted only if it denotes a REAL calendar day that
   * `new Date()` can parse. Everything else is NULL plus one tick on a counter.
   * Never invented, never "now" — a fabricated timestamp in a cursor is worse
   * than a missing row, because a cursor only ever moves forward.
   */
  it.each([
    ["MySQL zero date", "0000-00-00"],
    ["MySQL zero timestamp", "0000-00-00 00:00:00"],
    ["zero date, ISO spelling", "0000-00-00T00:00:00Z"],
    ["a day that does not exist", "2026-02-29"],
    ["month 13", "2026-13-01"],
    ["dd/mm/yyyy that does not exist", "31/02/2020"],
    ["prose", "tanggal tidak diketahui"],
  ])("refuses %s in po_date rather than handing it to postgres", (_name, value) => {
    const row = adaptSoHeaderRow({ tbl_1202_SOSalesOrderNID_id: "SOH-X", po_date: value });
    expect(row?.po_date).toBeNull();
  });

  it.each([
    ["MySQL zero timestamp", "0000-00-00 00:00:00"],
    ["MySQL zero date", "0000-00-00"],
    ["prose", "31 Februari kemarin"],
    ["an empty string", ""],
    ["a null", null],
  ])("refuses %s in updated_at — an Invalid Date must never reach the cursor", (_name, value) => {
    const row = adaptSoHeaderRow({ tbl_1202_SOSalesOrderNID_id: "SOH-X", updated_at: value });
    expect(row?.erp_updated_at).toBeNull();
  });

  it("treats a zero `deleted_at` as NOT DELETED, not as a broken deletion", () => {
    // The alternative — "it has a value, so the row is gone" — would silently
    // delete every legacy row whose deleted_at was never set.
    const row = adaptSoHeaderRow({ tbl_1202_SOSalesOrderNID_id: "SOH-X", deleted_at: MYSQL_ZERO_DATE });
    expect(row?.deleted_at).toBeNull();
  });

  it("applies the same rule to so_line.estimate_delivery — one shared helper, not one patched adapter", () => {
    const bad = adaptSoLineRow({
      tbl_1203_SOSalesOrderDetailNID_id: "SOL-X",
      estimate_delivery: "0000-00-00",
      updated_at: MYSQL_ZERO_DATE,
    });
    expect(bad?.estimate_delivery).toBeNull();
    expect(bad?.erp_updated_at).toBeNull();
  });

  it("still accepts every date shape that IS real", () => {
    const row = adaptSoHeaderRow({
      tbl_1202_SOSalesOrderNID_id: "SOH-Y",
      po_date: "14/03/2020", // A17: day-first
      updated_at: "2026-09-02 01:15:00", // A18: naive, read as UTC
    });
    expect(row?.po_date).toBe("2020-03-14");
    expect(row?.erp_updated_at?.toISOString()).toBe("2026-09-02T01:15:00.000Z");
    expect(adaptSoHeaderRow({ tbl_1202_SOSalesOrderNID_id: "S", po_date: "2024-02-29" })?.po_date).toBe("2024-02-29");
    expect(adaptSoHeaderRow({ tbl_1202_SOSalesOrderNID_id: "S", po_date: "2026-08-14T09:00:00Z" })?.po_date).toBe(
      "2026-08-14",
    );
  });

  it("counts the refusals on the page, alongside the numeric ones", async () => {
    faults.rows = { so_header: BAD_DATE_HEADERS };
    const res = await fetchPage("so_header", { since: null, page: 1, limit: 50 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // SOH-ZERO (po_date + updated_at) and SOH-GARBAGE (po_date + updated_at).
    // A null or blank date is ABSENT, not broken, and is deliberately not counted.
    expect(res.page.badDates.count).toBe(4);
    expect(res.page.badDates.samples.length).toBeLessThanOrEqual(3);
    expect(res.page.badDates.samples).toContain("0000-00-00");
    // Tokens only — never a whole row, which could carry customer data.
    expect(res.page.badDates.samples.join("|")).not.toContain("PT Tanggal Nol");
    // Every row still came through; nothing was dropped over a date.
    expect(res.page.rows).toHaveLength(BAD_DATE_HEADERS.length);
  });
});

describe("parseErpNumber — the separator ambiguity (A22)", () => {
  // "1.234" is 1234 in Indonesian notation and 1.234 in English notation. This
  // company's own stock data is documented id-locale (`num()` in routes/stock.ts,
  // PRD §8.4) and reading it wrong was a real bug (fc4ab5a) — but "0.350" is a
  // genuine 0.35 thickness that the id rule turns into 350. No parser is correct
  // without knowing the emitter, so `auto` REFUSES rather than picking.
  //
  // token          | auto          | id      | en
  const CASES: ReadonlyArray<readonly [string, number | "refused", number, number]> = [
    ["1.234", "refused", 1234, 1.234],
    ["1,234", "refused", 1.234, 1234],
    ["0.350", "refused", 350, 0.35],
    ["1.234,50", 1234.5, 1234.5, 1234.5], // both separators ⇒ last one is the decimal
    ["1,234.50", 1234.5, 1234.5, 1234.5], // …in either convention. Unambiguous.
    ["0,35", 0.35, 0.35, 0.35], // 2 digits after ⇒ cannot be grouping
    ["1234", 1234, 1234, 1234], // no separator at all
  ];

  /** Drops `nonFinite` (X11's channel) so these cases read as a locale table. */
  const read = (token: unknown, mode: "auto" | "id" | "en") => {
    const r = parseErpNumber(token, mode);
    return { value: r.value, ambiguous: r.ambiguous };
  };

  it.each(CASES)("reads %s as auto=%s id=%s en=%s", (token, auto, id, en) => {
    expect(read(token, "auto")).toEqual(
      auto === "refused" ? { value: null, ambiguous: true } : { value: auto, ambiguous: false },
    );
    expect(read(token, "id")).toEqual({ value: id, ambiguous: false });
    expect(read(token, "en")).toEqual({ value: en, ambiguous: false });
  });

  it("REFUSES the ambiguous shapes under auto — it never picks a locale", () => {
    // '1,810' is the exact string this suite's own fixture used to carry on the
    // happy path. It is 1810 in en notation and 1.810 in id notation, so under
    // `auto` it is refused — the fixture was changed, not the parser.
    for (const token of ["1.234", "1,234", "1,810", "0.350", "12.345", "999,999"]) {
      const read = parseErpNumber(token, "auto");
      expect(read.ambiguous).toBe(true);
      expect(read.value).toBeNull();
    }
  });

  it("passes JSON numbers through untouched in every mode — they are unambiguous", () => {
    for (const mode of ["auto", "id", "en"] as const) {
      expect(read(1234, mode)).toEqual({ value: 1234, ambiguous: false });
      expect(read(1.234, mode)).toEqual({ value: 1.234, ambiguous: false });
      expect(read(0.35, mode)).toEqual({ value: 0.35, ambiguous: false });
      expect(read(-2084, mode)).toEqual({ value: -2084, ambiguous: false });
      expect(read(0, mode)).toEqual({ value: 0, ambiguous: false });
    }
  });

  it("treats a repeated separator as grouping — it cannot be a decimal point", () => {
    expect(read("1.234.567", "auto")).toEqual({ value: 1234567, ambiguous: false });
    expect(read("1,234,567", "auto")).toEqual({ value: 1234567, ambiguous: false });
  });

  it("keeps signs, and refuses garbage as null rather than NaN", () => {
    expect(parseErpNumber("-1234", "auto").value).toBe(-1234);
    expect(parseErpNumber("-0,35", "auto").value).toBe(-0.35);
    for (const junk of ["bukan angka", "", "  ", "1.2a", "1.2.3", null, undefined, {}]) {
      const r = parseErpNumber(junk, "auto");
      expect(r.value).toBeNull();
      expect(r.ambiguous).toBe(false); // unreadable is not the same as ambiguous
      expect(r.nonFinite).toBe(false); // …nor the same as NaN/Infinity (X11)
    }
  });

  it("resolves 4-digit heads as decimals: grouping is always exactly three digits", () => {
    // "1234.567" cannot be grouping (that would be "1.234.567"), so it is decimal
    // in both conventions and must NOT be refused.
    expect(read("1234.567", "auto")).toEqual({ value: 1234.567, ambiguous: false });
  });
});

describe("non-finite numerics are rejected at the adapter boundary (X11)", () => {
  // `'NaN'::numeric` and `'Infinity'::numeric` are LEGAL values in Postgres and
  // the frozen schema does not forbid them in th / p / l. One stored there would
  // make `erp_sku_key()` render the literal text `NaN` while `canonicalSkuKey()`
  // renders `'-'` — the two implementations would disagree (invariant §7.4) and
  // that SKU's commitments would silently stop matching its stock. The parity
  // test cannot catch it, because the divergence is created at WRITE time.
  const NON_FINITE = ["NaN", "nan", "Infinity", "-Infinity", "INF", "1e999", "-1e999"];

  it.each(NON_FINITE)("flags %s as non-finite, never as a value", (token) => {
    const r = parseErpNumber(token, "auto");
    expect(r.value).toBeNull();
    expect(r.nonFinite).toBe(true);
    expect(r.ambiguous).toBe(false);
  });

  /** Each side's OWN column name for the same measurement (the 2026-09-11 map). */
  const SO_KEY = { th: "th_alu_skin", th_panel: "total_thickness_acp", p: "p", l: "l" } as const;
  const FG_KEY = { th: "th", th_panel: "t", p: "p", l: "l" } as const;

  it.each(["th", "th_panel", "p", "l"] as const)(
    "keeps a non-finite out of the sku_key-bearing column %s, on BOTH sides of the join",
    (column) => {
      const line = adaptSoLineRow({ id: "X", brand: "ACP", warna: "4", th_alu_skin: 0.3, total_thickness_acp: 4, p: 4880, l: 1220, [SO_KEY[column]]: "NaN" });
      const fg = adaptLiveFgRow({ sn_fg: "X", brand: "ACP", warna: "4", th: 0.3, t: 4, p: 4880, l: 1220, [FG_KEY[column]]: "Infinity" });
      expect(line?.[column]).toBeNull();
      expect(fg?.[column]).toBeNull();
      // Null degrades to the '-' placeholder, which is exactly what the SQL twin
      // produces for a NULL column — so the two keys still agree.
      expect(line?.sku_key).toContain("-");
      expect(line?.sku_key).not.toContain("NaN");
      expect(fg?.sku_key).not.toContain("Infinity");
      // A NULL on both sides still joins demand to supply consistently.
      expect(line?.sku_key).toBe(fg?.sku_key);
    },
  );

  it.each(["qty_order", "qty_delivered"] as const)("nulls the nullable SO column %s", (column) => {
    const row = adaptSoLineRow({ id: "X", qty_order: "NaN", qty_delivered: "Infinity", qty_balance: 5 });
    expect(row?.[column]).toBeNull();
  });

  it.each(["qty_m2", "buffer_qty"] as const)("nulls the nullable FG column %s", (column) => {
    const row = adaptLiveFgRow({ sn_fg: "X", qty_m2: "NaN", buffer_qty: "-Infinity", qty: 5 });
    expect(row?.[column]).toBeNull();
  });

  it("floors the two NOT NULL columns to 0 rather than writing NaN (A23)", () => {
    // `numeric not null` would happily accept NaN; 0 is the safe refusal, since
    // it reserves nothing and promises nothing.
    expect(adaptSoLineRow({ id: "X", qty_balance: "NaN" })?.qty_balance).toBe(0);
    expect(adaptLiveFgRow({ sn_fg: "X", qty: "Infinity" })?.qty).toBe(0);
  });

  it("counts non-finites separately from ambiguous ones — they need different fixes", async () => {
    const res = await fetchPage("live_fg", { since: null, page: 4, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Page 4 is FG-0006 (all non-finite) plus the null row.
      expect(res.page.nonFiniteNumbers.count).toBeGreaterThan(0);
      expect(res.page.ambiguousNumbers.count).toBe(0);
      expect(res.page.nonFiniteNumbers.samples.length).toBeLessThanOrEqual(3);
    }
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

describe("the verified envelope — success, and what a failed page must not do", () => {
  it("reads the real envelope and flags it as the expected shape", () => {
    const env = readEnvelope(
      {
        success: true,
        table: "tbl_1203_SOSalesOrderDetailNID",
        meta: { count: 1, total: 7, total_pages: 4, page: 1, limit: 2, offset: 0, order_by: "updated_at", order_dir: "asc", filters: {} },
        data: [{ id: 1 }],
      },
      2,
    );
    expect(env.rows).toHaveLength(1);
    expect(env.totalPages).toBe(4);
    expect(env.success).toBe(true);
    expect(env.matchedAssumption).toBe(true);
  });

  it("treats success:false as a FAILED page, not an empty one (FIX 5)", async () => {
    faults = { unsuccessful: { "so_header:1": true } };
    const res = await fetchPage("so_header", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toContain("success=false");
      expect(res.retryable).toBe(false); // the ERP understood us and said no
    }
    expect(requestLog).toHaveLength(1);
  });

  it("reports success:null when the body carries no such field", () => {
    expect(readEnvelope([{ id: 1 }], 10).success).toBeNull();
    expect(readEnvelope({ data: [{ id: 1 }] }, 10).success).toBeNull();
  });
});

describe("a 401 gets its own unmistakable line (FIX 5)", () => {
  it("logs once per process, names the auth mode, and never prints a credential", async () => {
    const { resetAuthNotices } = await import("../src/erp/selarasClient.js");
    resetAuthNotices();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      faults = { status: { "so_line:1": 401 } };
      const first = await fetchPage("so_line", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
      await fetchPage("so_line", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });

      const lines = error.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("REJECTED OUR CREDENTIALS"));
      expect(lines).toHaveLength(1); // once, not every three minutes
      expect(lines[0]).toContain("401");
      expect(lines[0]).toContain("X-Secret-Key");
      expect(lines[0]).toContain("SELARAS_AUTH_MODE");
      expect(lines[0]).not.toContain(TOKEN);
      // The returned error points at that line rather than repeating it.
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.error).toContain("credentials rejected");
    } finally {
      error.mockRestore();
    }
  });

  it("says what a 400 usually means, since that is the other likely first-run fault", async () => {
    faults = { status: { "so_line:1": 400 } };
    const res = await fetchPage("so_line", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("unknown filter");
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
  const fg = await sql<JsonRow[]>`select to_jsonb(t) - 'synced_at' as row from erp_live_fg t order by erp_row_id`;
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
  return sql<
    {
      table_name: string;
      cursor_value: Date | null;
      last_error: string | null;
      last_error_kind: string | null;
      running: boolean;
    }[]
  >`
    select table_name, cursor_value, last_error, last_error_kind, running
    from erp_sync_state order by table_name
  `;
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

function run(sql: postgres.Sql<{}>, log = silentLog) {
  return runErpSyncOnce({ db: sql, pageSize: PAGE_SIZE, intervalMs: 60_000, log });
}

/** The same pass, with the cursors cleared first: a FULL re-pull of every table. */
function runFull(sql: postgres.Sql<{}>, log = silentLog, actor = "wp2.ppic") {
  return runErpSyncOnce({ db: sql, pageSize: PAGE_SIZE, intervalMs: 60_000, log, full: true, actor });
}

function recompute(sql: postgres.Sql<{}>, log = silentLog) {
  return recomputeSkuKeys({ db: sql, intervalMs: 60_000, log });
}

/** Every path the fake ERP was asked for, for one logical table. */
function pathsFor(table: SelarasTable): string[] {
  const erpTable = Object.entries(ERP_TABLE_TO_LOGICAL).find(([, l]) => l === table)?.[0] ?? "";
  return requestLog.filter((p) => p.split("?")[0]?.endsWith(`/${erpTable}`));
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

  it("mirrors the fixture window, paging through every table in order", async () => {
    const result = await run(sql);
    expect(result.started).toBe(true);
    // The colour master first (small, and everything displays through it), then
    // headers before lines because lines reference them, and live_fg LAST so
    // on-hand is the freshest half of the ATP subtraction.
    expect(result.tables.map((t) => t.table)).toEqual(["warna", "so_header", "so_line", "live_fg"]);
    expect(result.tables.every((t) => t.ok)).toBe(true);

    const counts = await sql<{ h: number; l: number; f: number }[]>`
      select (select count(*)::int from erp_so_header) as h,
             (select count(*)::int from erp_so_line)   as l,
             (select count(*)::int from erp_live_fg)   as f
    `;
    expect(counts[0]).toEqual({ h: 3, l: 7, f: 6 });

    // PRD §5A: the two Black Galaxy rolls sum to 4,168 lembar on hand.
    const onHand = await sql<{ qty: string }[]>`
      select sum(qty)::text as qty from erp_live_fg where kode_barang = 'ACP-4MM'
    `;
    expect(onHand[0]?.qty).toBe("4168");

    // FIX B: the primary key is the ERP row id, and the ROLL SERIAL is kept in
    // its own column — `/api/stock/sku/:sku_key` shows it to an operator who is
    // matching it against a physical panel.
    const roll = await sql<{ erp_row_id: string; sn_fg: string | null }[]>`
      select erp_row_id, sn_fg from erp_live_fg where erp_row_id = 'FG-0001'
    `;
    expect(roll[0]).toEqual({ erp_row_id: "FG-0001", sn_fg: "SN-0001" });

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
      const rows = await sql<{ n: number }[]>`select count(*)::int as n from erp_live_fg where erp_row_id = 'FG-0001'`;
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
    expect(after[0]?.n).toBe(7);
  });

  it("survives malformed rows: they are dropped and counted, the run still succeeds", async () => {
    const result = await run(sql);
    expect(result.started).toBe(true);
    expect(result.tables.every((t) => t.ok)).toBe(true);

    const soLine = result.tables.find((t) => t.table === "so_line");
    const liveFg = result.tables.find((t) => t.table === "live_fg");
    expect(soLine?.dropped).toBe(2); // the id-less row and the bare string
    expect(liveFg?.dropped).toBe(2); // the serial-less row and the null

    // A22 and X11 are counted separately, because they need different fixes:
    // one is "tell me the emitter's locale", the other is "your ERP emitted NaN".
    expect(soLine?.ambiguousNumbers).toBeGreaterThan(0);
    expect(liveFg?.ambiguousNumbers).toBeGreaterThan(0);
    expect(liveFg?.nonFiniteNumbers).toBeGreaterThan(0);

    // The all-malformed line still landed, degraded rather than discarded.
    const degraded = await sql<{ qty_balance: string; th: string | null }[]>`
      select qty_balance::text, th::text from erp_so_line where id = 'SOL-2007'
    `;
    expect(degraded[0]?.qty_balance).toBe("0");
    expect(degraded[0]?.th).toBeNull();
  });

  it("survives a page of broken dates: bad values are NULLed and counted, the run still succeeds", async () => {
    // THE REGRESSION. In production this exact page aborted so_header on every
    // run for months — `[erp-sync] so_header: run aborted — Invalid time value`
    // — while so_line, live_fg and warna all completed, so the UI said
    // "Sinkronisasi ERP gagal" over three healthy tables and one stuck cursor.
    faults.rows = { so_header: BAD_DATE_HEADERS };

    const result = await run(sql);
    expect(result.started).toBe(true);
    const header = result.tables.find((t) => t.table === "so_header");
    expect(header?.error).toBeUndefined();
    expect(header?.ok).toBe(true);
    expect(result.tables.every((t) => t.ok)).toBe(true);

    // Counted, exactly like a non-finite numeric: two broken values on SOH-ZERO
    // and two on SOH-GARBAGE. A null or blank date is an ABSENT date, not a
    // broken one, and is deliberately not counted — po_date is nullable and a
    // null there is entirely routine.
    expect(header?.badDates).toBe(4);
    expect(header?.dropped).toBe(0); // a bad date never costs us the row

    // Every row is in the mirror, with the unreadable values as NULL and the
    // readable ones untouched.
    const mirrored = await sql<{ id: string; po_date: Date | null; erp_updated_at: Date | null }[]>`
      select id, po_date, erp_updated_at from erp_so_header order by id
    `;
    expect(mirrored.map((r) => r.id)).toEqual([
      "SOH-EMPTY",
      "SOH-GARBAGE",
      "SOH-NULL-TS",
      "SOH-OK-1",
      "SOH-OK-2",
      "SOH-ZERO",
    ]);
    const byId = new Map(mirrored.map((r) => [r.id, r]));
    expect(byId.get("SOH-ZERO")?.po_date).toBeNull();
    expect(byId.get("SOH-ZERO")?.erp_updated_at).toBeNull();
    expect(byId.get("SOH-GARBAGE")?.po_date).toBeNull();
    expect(byId.get("SOH-EMPTY")?.po_date).toBeNull();
    expect(byId.get("SOH-NULL-TS")?.erp_updated_at).toBeNull();
    expect(byId.get("SOH-OK-2")?.erp_updated_at?.getTime()).toBe(BAD_DATE_HEADERS_MAX_VALID.getTime());

    // Nothing was invented: not one fabricated date anywhere in the mirror, and
    // in particular nothing dated "now" standing in for a value we could not read.
    const invented = await sql<{ n: number }[]>`
      select count(*)::int as n from erp_so_header
       where po_date > current_date or erp_updated_at > now() - interval '1 minute'
    `;
    expect(invented[0]?.n).toBe(0);

    // AND THE POINT OF ALL OF IT: the cursor moved, off the good rows alone.
    const state = await syncStateRows(sql);
    const cursor = state.find((r) => r.table_name === "so_header")?.cursor_value;
    expect(cursor?.getTime()).toBe(BAD_DATE_HEADERS_MAX_VALID.getTime());
    expect(header?.cursorAfter?.getTime()).toBe(BAD_DATE_HEADERS_MAX_VALID.getTime());
  });

  it("logs the bad-date refusal ONCE per table per run, with examples and a remedy", async () => {
    faults.rows = { so_header: BAD_DATE_HEADERS };
    const lines: string[] = [];
    await run(sql, { info: () => {}, warn: (m: string) => lines.push(m), error: () => {} });

    const refusals = lines.filter((l) => l.includes("unreadable date value"));
    // One line per AFFECTED TABLE, not one per row: so_header here, and so_line,
    // whose fixture has carried "31 Desember" / "bukan tanggal" all along.
    expect(refusals).toHaveLength(2);
    expect(refusals.filter((l) => l.startsWith("so_header:"))).toHaveLength(1);
    expect(refusals.filter((l) => l.startsWith("so_line:"))).toHaveLength(1);

    const headerLine = refusals.find((l) => l.startsWith("so_header:")) ?? "";
    expect(headerLine).toMatch(/^so_header: refused 4 unreadable date value\(s\)/);
    expect(headerLine).toContain('"0000-00-00"'); // the offending token, quoted
    expect(headerLine).toContain("Invalid time value"); // …and what it used to do
    // Tokens only, never a whole row: customer names must not reach a log line.
    expect(headerLine).not.toContain("PT Tanggal Nol");
    expect(headerLine).not.toContain("SOH-ZERO");
  });

  it("leaves the cursor untouched when a page yields NO valid timestamp at all", async () => {
    // Not an error, and emphatically not a guess: there is simply nothing to
    // advance to. The next run re-pulls the same window and tries again. The
    // alternative — falling back to `now()` — would be permanent data loss,
    // because the cursor only ever moves forward.
    faults.rows = { so_header: ALL_BAD_DATE_HEADERS };

    const result = await run(sql);
    const header = result.tables.find((t) => t.table === "so_header");
    expect(header?.ok).toBe(true);
    expect(header?.error).toBeUndefined();
    expect(header?.badDates).toBe(4); // two po_dates, two updated_ats
    expect(header?.cursorAfter).toBeNull();

    const state = await syncStateRows(sql);
    const row = state.find((r) => r.table_name === "so_header");
    expect(row?.cursor_value).toBeNull(); // still exactly where it started
    expect(row?.last_error).toBeNull();

    // The rows themselves are mirrored — only their dates were unreadable.
    const mirrored = await sql<{ id: string; po_date: Date | null }[]>`
      select id, po_date from erp_so_header order by id
    `;
    expect(mirrored.map((r) => r.id)).toEqual(["SOH-ALLBAD-1", "SOH-ALLBAD-2"]);
    expect(mirrored.every((r) => r.po_date === null)).toBe(true);

    // And a second run over the same untouched cursor is still fine — the page
    // replays rather than being skipped.
    const again = await run(sql);
    expect(again.tables.every((t) => t.ok)).toBe(true);
    expect((await syncStateRows(sql)).find((r) => r.table_name === "so_header")?.cursor_value).toBeNull();
  });

  it("survives a total ERP outage without throwing, and leaves the mirror intact", async () => {
    await run(sql);
    const mirrorBefore = await mirrorSnapshot(sql);

    faults = {
      status: { "warna:1": 500, "so_header:1": 500, "so_line:1": 500, "live_fg:1": 500 },
    };
    const result = await run(sql);

    expect(result.started).toBe(true); // resolved, did not reject
    expect(result.tables.every((t) => !t.ok)).toBe(true);
    expect(await mirrorSnapshot(sql)).toEqual(mirrorBefore);

    const states = await syncStateRows(sql);
    expect(states.every((s) => s.running === false)).toBe(true);
    expect(states.every((s) => (s.last_error ?? "").length > 0)).toBe(true);
    // FIX D: a 5xx is classified `server`, not `auth` — the page must not tell
    // an operator to call IT when the ERP is merely down.
    expect(states.every((s) => s.last_error_kind === "server")).toBe(true);
  });

  // ── FIX 6 · soft deletes ───────────────────────────────────────────────────

  it("never mirrors a row that arrives already carrying deleted_at", async () => {
    await run(sql);

    const gone = await sql<{ n: number }[]>`
      select (
        (select count(*) from erp_so_line   where id         = 'SOL-2009')
      + (select count(*) from erp_live_fg   where erp_row_id = 'FG-0007')
      + (select count(*) from erp_so_header where id         = 'SOH-1004')
      )::int as n
    `;
    // FG-0007 alone carries 5,000 lembar and SOL-2009 reserves 900. Mirroring a
    // deleted FG row over-promises stock that does not physically exist — the
    // direction this module exists to prevent.
    expect(gone[0]?.n).toBe(0);
  });

  it("REMOVES a row from the mirror once the ERP marks it deleted (FIX 6)", async () => {
    await run(sql);
    const before = await sql<{ n: number }[]>`select count(*)::int as n from erp_so_line where id = 'SOL-2001'`;
    expect(before[0]?.n).toBe(1);

    // The ERP soft-deletes it. `deleted_at` is the routine deletion signal; the
    // hourly reconciliation sweep is only the backstop for a hard delete.
    const original = FIXTURES.so_line;
    const live = original[0] as Record<string, unknown>;
    FIXTURES.so_line = [{ ...live, deleted_at: "2026-09-08T10:00:00Z" }, ...original.slice(1)];
    try {
      await resetCursors(sql);
      const result = await run(sql);
      const soLine = result.tables.find((t) => t.table === "so_line");
      expect(soLine?.ok).toBe(true);
      expect(soLine?.deleted).toBeGreaterThan(0);

      const after = await sql<{ n: number }[]>`select count(*)::int as n from erp_so_line where id = 'SOL-2001'`;
      expect(after[0]?.n).toBe(0);
      // …and it stops reserving, which is the only reason any of this matters.
      const live_rows = await sql<{ n: number }[]>`
        select count(*)::int as n from v_live_commitments where id = 'SOL-2001'
      `;
      expect(live_rows[0]?.n).toBe(0);
    } finally {
      FIXTURES.so_line = original;
    }
  });

  // ── FIX 7 · the colour master ──────────────────────────────────────────────

  it("mirrors the colour master so a page can read BLACK GALAXY, not 4", async () => {
    await run(sql);
    const rows = await sql<{ id: string; code: string | null; code_num: string | null; rm_warna: string | null }[]>`
      select id, code, code_num::text as code_num, rm_warna from erp_warna order by id
    `;
    expect(rows.map((r) => r.id)).toEqual(["118", "4"]); // 999 is soft-deleted
    const black = rows.find((r) => r.id === "4");
    expect(black?.rm_warna).toBe("BLACK GALAXY");
    expect(black?.code_num).toBe("4"); // so a mirrored '004' still resolves
  });

  // ── FIX 1 · the ST-R5.2 safety net ─────────────────────────────────────────

  it("shouts, ONCE and loudly, when most live commitments match no stock at all", async () => {
    // The alarm that stands in for ST-R5.2, which could not be run against live
    // data. A few unmatched keys are normal (that is the exceptions tray); a
    // MAJORITY unmatched is what a broken key composition looks like, and it
    // fails toward over-promising: those commitments reserve nothing, so ATP
    // equals on-hand and the whole inventory reads as promiseable.
    await run(sql);
    // Break the join the way a wrong segment list would: move the stock rows to
    // a different key, leaving the demand keyed where it was.
    await sql`update erp_live_fg set sku_key = sku_key || '|X'`;

    const errors: string[] = [];
    const report = await migrateMod.checkSkuKeyMatch(sql, { error: (m: string) => errors.push(m) });

    expect(report.checked).toBe(true);
    expect(report.liveLines).toBeGreaterThan(0);
    expect(report.ratio).toBe(1);
    expect(report.tripped).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("SKU KEY MATCHES ALMOST NOTHING");
    expect(errors[0]).toContain("100%");
    expect(errors[0]).toContain("STOCK_SKU_KEY_SEGMENTS"); // the knob, named
    expect(errors[0]).toContain("SKU_SEGMENT_SOURCES"); // …and the mapping
    // Example keys from BOTH sides, so the mismatch is diagnosable by eye.
    expect(report.soSamples.length).toBeGreaterThan(0);
    expect(report.fgSamples.length).toBeGreaterThan(0);
    expect(errors[0]).toContain(report.soSamples[0]!);
    expect(errors[0]).toContain(report.fgSamples[0]!);
  });

  it("stays quiet when the key matches, and when there is no demand at all", async () => {
    await run(sql);
    const errors: string[] = [];
    const matched = await migrateMod.checkSkuKeyMatch(sql, { error: (m: string) => errors.push(m) });
    expect(matched.tripped).toBe(false);
    expect(matched.liveLines).toBeGreaterThan(0);

    // An empty mirror is not evidence of a broken key. Warning here would fire on
    // every fresh deployment forever, which is how a real alert gets ignored.
    await sql`truncate erp_so_line`;
    const empty = await migrateMod.checkSkuKeyMatch(sql, { error: (m: string) => errors.push(m) });
    expect(empty.liveLines).toBe(0);
    expect(empty.tripped).toBe(false);
    expect(errors).toEqual([]);
  });

  it("honours STOCK_UNMATCHED_ALERT_RATIO as the threshold", async () => {
    await run(sql);
    await sql`update erp_live_fg set sku_key = sku_key || '|X'`;
    const errors: string[] = [];
    // A threshold of 1 means "only complain above 100% unmatched", which nothing
    // can exceed — the knob genuinely gates the alarm.
    const report = await migrateMod.checkSkuKeyMatch(sql, { error: (m: string) => errors.push(m) }, 1);
    expect(report.ratio).toBe(1);
    expect(report.tripped).toBe(false);
    expect(errors).toEqual([]);
  });

  it("emits the column diagnostic exactly ONCE per table per run (ST-R5.3)", async () => {
    await resetCursors(sql);
    const lines: string[] = [];
    const recorder = {
      info: (m: string) => lines.push(m),
      warn: (m: string) => lines.push(m),
      error: (m: string) => lines.push(m),
    };
    const first = await runErpSyncOnce({ db: sql, pageSize: PAGE_SIZE, intervalMs: 60_000, log: recorder });
    expect(first.started).toBe(true);

    // live_fg alone is read over five pages at this page size — the guarantee is
    // per TABLE per RUN, not per page and certainly not per row.
    expect(first.tables.find((t) => t.table === "live_fg")?.pages).toBeGreaterThan(1);

    const diagnostics = lines.filter((m) => m.includes("COLUMN DIAGNOSTIC"));
    expect(diagnostics).toHaveLength(4);
    for (const table of ["warna", "so_header", "so_line", "live_fg"] as const) {
      expect(diagnostics.filter((m) => m.startsWith(`${table}: COLUMN DIAGNOSTIC`)), table).toHaveLength(1);
    }

    // It names the REAL wire keys of the fixture — which is the only thing that
    // makes the next production sync answer the mapping question by itself.
    const fg = diagnostics.find((m) => m.startsWith("live_fg:")) ?? "";
    expect(fg).toContain("kode_barang");
    expect(fg).toContain("tbl_1210_STLiveFGMX_id");
    expect(fg).toContain("th (numeric): probed [th] → matched 'th'");
    expect(fg).toContain("th_panel (numeric): probed [t] → matched 't'");
    const so = diagnostics.find((m) => m.startsWith("so_line:")) ?? "";
    expect(so).toContain("probed [th_alu_skin] → matched 'th_alu_skin'");

    // And it leaks nothing: no row content, no credential.
    for (const m of diagnostics) {
      expect(m).not.toContain(TOKEN);
      expect(m).not.toContain("PT Sinar Mandiri"); // a customer name, from so_header
      expect(m).not.toContain("SN-0001"); // a roll serial, from live_fg
    }

    // Per RUN, not per process: the next run says it again, because the wire
    // shape can change under us between runs.
    await resetCursors(sql);
    const second: string[] = [];
    await runErpSyncOnce({
      db: sql,
      pageSize: PAGE_SIZE,
      intervalMs: 60_000,
      log: { info: (m: string) => second.push(m), warn: () => {}, error: () => {} },
    });
    expect(second.filter((m) => m.includes("COLUMN DIAGNOSTIC"))).toHaveLength(4);
  });

  it("the diagnostic changes nothing: same mirror, same ATP, with it and without", async () => {
    // It is observation only. Byte-identical rows and byte-identical ATP are the
    // acceptance criterion for the whole sync (§5), so they are the right test.
    await resetCursors(sql);
    await runErpSyncOnce({ db: sql, pageSize: PAGE_SIZE, intervalMs: 60_000, log: silentLog });
    const withDiagnostic = await atpSnapshot(sql);
    const fgWith = await sql`select erp_row_id, sku_key, qty::text from erp_live_fg order by erp_row_id`;

    vi.resetModules();
    process.env["STOCK_SYNC_DIAGNOSE_COLUMNS"] = "false";
    try {
      const isolated = await import("../src/erp/syncWorker.js");
      await resetCursors(sql);
      const off = await isolated.runErpSyncOnce({ db: sql, pageSize: PAGE_SIZE, intervalMs: 60_000, log: silentLog });
      expect(off.started).toBe(true);
      expect(await atpSnapshot(sql)).toEqual(withDiagnostic);
      expect(await sql`select erp_row_id, sku_key, qty::text from erp_live_fg order by erp_row_id`).toEqual(fgWith);
    } finally {
      delete process.env["STOCK_SYNC_DIAGNOSE_COLUMNS"];
      vi.resetModules();
    }
  });

  it("records an auth failure as a typed kind, not as prose (FIX D)", async () => {
    const { resetAuthNotices } = await import("../src/erp/selarasClient.js");
    resetAuthNotices();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      faults = { status: { "so_line:1": 401 } };
      await run(sql);
      const state = (await syncStateRows(sql)).find((r) => r.table_name === "so_line");
      expect(state?.last_error_kind).toBe("auth");
      expect(state?.last_error).toBeTruthy();
      expect(state?.last_error).not.toContain(TOKEN);
    } finally {
      spy.mockRestore();
    }
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

  it("refuses ambiguous quantities rather than writing a 1000x-wrong one (A22)", async () => {
    await run(sql);

    // SOL-2008 carries qtyBalance "1.234" and th "0.350". Guessing id would
    // reserve 1234 lembar; guessing en would reserve 1.234. Refusing reserves
    // nothing, which is the only answer that cannot be wrong by 1000x.
    const line = await sql<{ qty_balance: string; th: string | null; sku_key: string }[]>`
      select qty_balance::text, th::text, sku_key from erp_so_line where id = 'SOL-2008'
    `;
    expect(line[0]?.qty_balance).toBe("0");
    expect(line[0]?.th).toBeNull();

    // FG-0005 carries Qty "1.234" and QtyM2 "2,500".
    const fg = await sql<{ qty: string; qty_m2: string | null }[]>`
      select qty::text, qty_m2::text from erp_live_fg where erp_row_id = 'FG-0005'
    `;
    expect(fg[0]?.qty).toBe("0");
    expect(fg[0]?.qty_m2).toBeNull();

    // And the Black Galaxy on-hand is untouched — only ambiguous tokens refuse.
    const onHand = await sql<{ qty: string }[]>`
      select sum(qty)::text as qty from erp_live_fg where kode_barang = 'ACP-4MM'
    `;
    expect(onHand[0]?.qty).toBe("4168");
  });

  it("logs the A22 refusal ONCE per table per run, with the tokens and the remedy", async () => {
    const lines: string[] = [];
    await run(sql, { info: () => {}, warn: (m: string) => lines.push(m), error: () => {} });

    const a22 = lines.filter((l) => l.includes("ambiguous numeric"));
    expect(a22).toHaveLength(2); // so_line and live_fg, one line each
    const soLineLine = a22.find((l) => l.startsWith("so_line:"));
    expect(soLineLine).toContain('"1.234"'); // the offending token, quoted
    expect(soLineLine).toContain("SELARAS_NUMBER_FORMAT"); // …and what to do about it
    // Tokens only — never a whole row, which could carry customer data.
    expect(soLineLine).not.toContain("SOH-1001");
    expect(soLineLine).not.toContain("PT Sinar Mandiri");

    const x11 = lines.filter((l) => l.includes("non-finite numeric"));
    expect(x11).toHaveLength(1); // live_fg only
    expect(x11[0]).toContain("sku_key");
  });

  it("stores NO non-finite numeric anywhere in the mirror (X11)", async () => {
    await run(sql);

    // FG-0006 is mirrored — it has a serial, so it is a real row — but every one
    // of its numerics was refused at the adapter.
    const fg = await sql<{ th: string | null; p: string | null; l: string | null; qty: string; qty_m2: string | null }[]>`
      select th::text, p::text, l::text, qty::text, qty_m2::text from erp_live_fg where erp_row_id = 'FG-0006'
    `;
    expect(fg[0]).toEqual({ th: null, p: null, l: null, qty: "0", qty_m2: null });

    // The real guarantee, stated over the whole mirror rather than one row:
    // not a single NaN or Infinity in any numeric column of either table.
    const bad = await sql<{ n: number }[]>`
      select (
        (select count(*) from erp_live_fg
          where th in ('NaN','Infinity','-Infinity') or p in ('NaN','Infinity','-Infinity')
             or l in ('NaN','Infinity','-Infinity') or qty in ('NaN','Infinity','-Infinity')
             or qty_m2 in ('NaN','Infinity','-Infinity') or buffer_qty in ('NaN','Infinity','-Infinity'))
        + (select count(*) from erp_so_line
          where th in ('NaN','Infinity','-Infinity') or p in ('NaN','Infinity','-Infinity')
             or l in ('NaN','Infinity','-Infinity') or qty_balance in ('NaN','Infinity','-Infinity')
             or qty_order in ('NaN','Infinity','-Infinity') or qty_delivered in ('NaN','Infinity','-Infinity'))
      )::int as n
    `;
    expect(bad[0]?.n).toBe(0);

    // And the TS key for that row agrees with the SQL key — which is the whole
    // point of X11. A stored NaN would make these two differ silently.
    const parity = await sql<{ stored: string; computed: string }[]>`
      select sku_key as stored, erp_sku_key(brand, warna, th, th_panel, p, l) as computed
        from erp_live_fg where erp_row_id = 'FG-0006'
    `;
    expect(parity[0]?.stored).toBe(parity[0]?.computed);
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

  // ═══════════════════════════════════════════════════════════════════════════
  // The stale-data repairs — the two of them, and which one fixes what.
  //
  // The hazard these exist for: EVERY derived value in the mirror (`sku_key`,
  // and the parsed `th`/`th_panel`/`p`/`l` it is built from) is computed at WRITE
  // time and stored. The cursor only ever moves FORWARD. So a fix to how a value
  // is read or how the key is composed reaches exactly the rows pulled after it,
  // and rows behind the cursor keep the old answer forever.
  //
  //   · key composition changed, columns intact  → recompute in place, no ERP
  //   · the COLUMNS are wrong (refused/misparsed) → nothing but a full re-pull
  // ═══════════════════════════════════════════════════════════════════════════

  describe("full re-sync (cursor reset) and the in-place sku_key recompute", () => {
    /** so_line's oldest row — 2026-09-01T02:05Z, far behind the cursor a full pass leaves. */
    const OLD_LINE = "SOL-2001";

    it("a FULL re-sync clears every cursor and re-pulls rows an incremental one can never see", async () => {
      await run(sql); // a normal pass: mirror filled, every cursor advanced
      const seeded = await syncStateRows(sql);
      expect(seeded.find((r) => r.table_name === "so_line")?.cursor_value).not.toBeNull();

      // Stand in for a row that was mirrored WRONG and has since fallen behind
      // the cursor. Deleting it is the sharpest possible form of "wrong": if an
      // incremental pass could still reach it, it would come back.
      await sql`delete from erp_so_line where id = ${OLD_LINE}`;

      requestLog = [];
      const incremental = await run(sql);
      expect(incremental.full).toBe(false);
      expect(incremental.cursorsCleared).toBe(0);
      expect(incremental.recompute).toBeUndefined();
      // It really did ask with a cursor, and the row really did not come back.
      expect(pathsFor("so_line").every((p) => p.includes("updated_at__gte="))).toBe(true);
      const missing = await sql<{ n: number }[]>`select count(*)::int as n from erp_so_line where id = ${OLD_LINE}`;
      expect(missing[0]?.n).toBe(0);

      // Cursors are NOT cleared by an incremental pass — that is the whole
      // difference between the two, and the reason the old row stayed missing.
      const afterIncremental = await syncStateRows(sql);
      for (const t of afterIncremental) {
        const before = seeded.find((r) => r.table_name === t.table_name);
        expect(t.cursor_value).not.toBeNull();
        expect(t.cursor_value?.getTime()).toBe(before?.cursor_value?.getTime());
      }

      requestLog = [];
      const full = await runFull(sql);
      expect(full.started).toBe(true);
      expect(full.full).toBe(true);
      expect(full.cursorsCleared).toBe(SYNC_TABLE_COUNT);
      expect(full.tables.every((t) => t.ok)).toBe(true);

      // The cursor was genuinely gone when the pull ran: not one request for any
      // table carried updated_at__gte.
      expect(requestLog.length).toBeGreaterThan(0);
      expect(requestLog.some((p) => p.includes("updated_at__gte="))).toBe(false);

      // And the row an incremental pass structurally could not reach is back.
      const back = await sql<{ n: number }[]>`select count(*)::int as n from erp_so_line where id = ${OLD_LINE}`;
      expect(back[0]?.n).toBe(1);

      // The cursors are advanced again afterwards, so the next tick is ordinary.
      const afterFull = await syncStateRows(sql);
      expect(afterFull.find((r) => r.table_name === "so_line")?.cursor_value).not.toBeNull();
      expect(afterFull.every((r) => r.running === false)).toBe(true);
    });

    it("re-pulling is idempotent: a full pass leaves the same rows and the same ATP as an incremental one", async () => {
      await run(sql);
      const mirrorBefore = await mirrorSnapshot(sql);
      const atpBefore = await atpSnapshot(sql);

      const full = await runFull(sql);
      expect(full.tables.every((t) => t.ok)).toBe(true);

      // Every write is an upsert by primary key (§5), so re-fetching a row that
      // has not changed rewrites it byte-identically. That is what makes a
      // 137k-row re-pull a safe thing to hand an operator.
      expect(await mirrorSnapshot(sql)).toEqual(mirrorBefore);
      expect(await atpSnapshot(sql)).toEqual(atpBefore);
    });

    it("a failure partway through a full re-sync leaves the mirror readable and the cursor behind the gap", async () => {
      await run(sql); // seven so_line rows mirrored and readable
      const mirrorBefore = await mirrorSnapshot(sql);

      faults = { status: { "so_line:2": 500 } };
      const full = await runFull(sql);

      expect(full.started).toBe(true); // resolved, never rejected
      expect(full.full).toBe(true);
      expect(full.cursorsCleared).toBe(SYNC_TABLE_COUNT);

      const soLine = full.tables.find((t) => t.table === "so_line");
      expect(soLine?.ok).toBe(false);
      expect(soLine?.pages).toBe(1); // page 1 committed, page 2 blew up

      // THE POINT: the cursor sits at page 1's high-water mark. Not null (that
      // would re-pull work already committed), and emphatically not past page 2 —
      // a cursor ahead of data that was never fetched would skip those rows
      // forever, which is the one outcome a re-pull must never produce.
      const state = (await syncStateRows(sql)).find((r) => r.table_name === "so_line");
      expect(state?.cursor_value?.toISOString()).toBe("2026-09-01T03:35:00.000Z");
      expect(state?.last_error).toBeTruthy();
      expect(state?.running).toBe(false); // the guard is always released

      // A half-repulled mirror is still a readable mirror: nothing was truncated
      // ahead of the pull, so every row that was there is still there.
      expect(await mirrorSnapshot(sql)).toEqual(mirrorBefore);

      // And an ordinary tick resumes from page 1's mark and finishes the job —
      // no second full re-pull needed.
      faults = {};
      const recovery = await run(sql);
      expect(recovery.tables.find((t) => t.table === "so_line")?.ok).toBe(true);
      const n = await sql<{ n: number }[]>`select count(*)::int as n from erp_so_line`;
      expect(n[0]?.n).toBe(7);
    });

    it("ABORTS a full re-sync, pulling nothing, if the cursor reset itself fails", async () => {
      await run(sql);
      const cursorsBefore = await syncStateRows(sql);

      // Fail the clear, and only the clear. Everything else on this handle works,
      // so the run genuinely reaches the reset and genuinely stops there.
      const proxy = new Proxy(sql, {
        apply(target: postgres.Sql<{}>, thisArg, args: unknown[]) {
          const text = String((args[0] as readonly string[])[0] ?? "");
          if (text.includes("set cursor_value = null")) throw new Error("cursor reset exploded");
          return Reflect.apply(target as never, thisArg, args as never);
        },
      }) as postgres.Sql<{}>;

      requestLog = [];
      const result = await runErpSyncOnce({
        db: proxy,
        pageSize: PAGE_SIZE,
        intervalMs: 60_000,
        log: silentLog,
        full: true,
      });

      expect(result.started).toBe(false);
      expect(result.skipped).toBe("cursor_reset_failed");
      expect(result.cursorsCleared).toBe(0);
      expect(result.tables).toEqual([]);
      // A half-cleared cursor set that nothing follows is the forbidden state.
      // One statement means all-or-nothing, and nothing is what happened.
      const cursorsAfter = await syncStateRows(sql);
      expect(cursorsAfter.map((r) => r.cursor_value?.toISOString() ?? null)).toEqual(
        cursorsBefore.map((r) => r.cursor_value?.toISOString() ?? null),
      );
      expect(cursorsAfter.every((r) => r.running === false)).toBe(true);
      // Nothing was pulled either — an aborted reset must not become a silent
      // incremental pass that the logs would describe as a full one.
      expect(requestLog).toEqual([]);
    });

    it("REFUSES a full re-sync while a run is in flight, and clears nothing on the way out", async () => {
      await run(sql);
      const cursorsBefore = await syncStateRows(sql);

      // The in-process half of the guard: the interval tick and the manual
      // re-pull share one `inFlight`, so they cannot interleave.
      const inFlight = run(sql);
      const refused = await runFull(sql);
      await inFlight;

      expect(refused.started).toBe(false);
      expect(refused.skipped).toBe("in_flight");
      expect(refused.cursorsCleared).toBe(0);

      const cursorsAfter = await syncStateRows(sql);
      expect(cursorsAfter.map((r) => r.cursor_value?.toISOString() ?? null)).toEqual(
        cursorsBefore.map((r) => r.cursor_value?.toISOString() ?? null),
      );
    });

    it("REFUSES a full re-sync while ANOTHER PROCESS holds the erp_sync_state guard", async () => {
      await run(sql);
      const cursorsBefore = await syncStateRows(sql);

      // `running = true` with fresh activity is a LIVE run, not an abandoned
      // lock — the staleness rule only reclaims a guard that has gone quiet for
      // three intervals, so this one is respected.
      await sql`update erp_sync_state set running = true, last_ok_at = now() where table_name = 'so_line'`;
      try {
        requestLog = [];
        const refused = await runFull(sql);
        expect(refused.started).toBe(false);
        expect(refused.skipped).toBe("locked");
        expect(refused.cursorsCleared).toBe(0);
        expect(requestLog).toEqual([]);

        const cursorsAfter = await syncStateRows(sql);
        expect(cursorsAfter.map((r) => r.cursor_value?.toISOString() ?? null)).toEqual(
          cursorsBefore.map((r) => r.cursor_value?.toISOString() ?? null),
        );
      } finally {
        await sql`update erp_sync_state set running = false`;
      }
    });

    // ── Repair (a): the key composition is stale, the columns are fine ────────

    it("the recompute rekeys a row whose stored key is stale, and leaves a correct key untouched", async () => {
      await run(sql);
      const before = await sql<{ id: string; sku_key: string }[]>`
        select id, sku_key from erp_so_line order by id
      `;
      expect(before.length).toBeGreaterThan(1);

      // One row carries a key from a retired composition. Its COLUMNS are intact,
      // which is the whole precondition for repairing it without the ERP.
      await sql`update erp_so_line set sku_key = 'RETIRED|COMPOSITION' where id = ${OLD_LINE}`;

      requestLog = [];
      const result = await recompute(sql);
      expect(result.started).toBe(true);
      expect(result.ok).toBe(true);
      expect(result.updated).toBe(1);
      expect(result.tables.map((t) => t.table)).toEqual(["so_line", "live_fg"]);
      // No ERP traffic at all — that is the entire advantage over a re-pull.
      expect(requestLog).toEqual([]);

      const after = await sql<{ id: string; sku_key: string }[]>`
        select id, sku_key from erp_so_line order by id
      `;
      expect(after).toEqual(before); // the stale one restored, every other one identical

      // Idempotent, and the second run is the diagnostic: nothing left to fix.
      const again = await recompute(sql);
      expect(again.updated).toBe(0);
      expect(await sql`select id, sku_key from erp_so_line order by id`).toEqual(before);

      // The guard is released both times.
      expect((await syncStateRows(sql)).every((r) => r.running === false)).toBe(true);
    });

    it("the recompute REFUSES to run while a sync holds the guard", async () => {
      const inFlight = run(sql);
      const refused = await recompute(sql);
      await inFlight;
      expect(refused.started).toBe(false);
      expect(refused.skipped).toBe("in_flight");
    });

    // ── Repair (b): the COLUMNS are wrong — only a re-pull can fix it ─────────

    it("the recompute cannot repair a row whose COLUMNS are wrong; the full re-sync can", async () => {
      await run(sql);
      const good = await sql<{ sku_key: string; p: string | null; l: string | null }[]>`
        select sku_key, p::text as p, l::text as l from erp_so_line where id = ${OLD_LINE}
      `;
      expect(good[0]?.p).not.toBeNull();
      expect(good[0]?.l).not.toBeNull();

      // EXACTLY the production damage: mirrored while SELARAS_NUMBER_FORMAT was
      // `auto`, where "2.440" is structurally ambiguous and was correctly refused
      // rather than guessed — so p and l were written NULL and the key that was
      // computed from them, at write time, ends in the '-' placeholders.
      await sql`
        update erp_so_line
           set p = null, l = null, sku_key = erp_sku_key(brand, warna, th, th_panel, null, null)
         where id = ${OLD_LINE}
      `;
      const broken = await sql<{ sku_key: string }[]>`select sku_key from erp_so_line where id = ${OLD_LINE}`;
      expect(broken[0]?.sku_key).toMatch(/\|-\|-$/);

      // The cheap repair changes NOTHING, and that is the correct answer, not a
      // bug: the stored key already agrees with the stored columns. Recomputing
      // a key from broken inputs reproduces the broken key.
      const cheap = await recompute(sql);
      expect(cheap.started).toBe(true);
      expect(cheap.updated).toBe(0);
      const stillBroken = await sql<{ sku_key: string; p: string | null }[]>`
        select sku_key, p::text as p from erp_so_line where id = ${OLD_LINE}
      `;
      expect(stillBroken[0]?.sku_key).toBe(broken[0]?.sku_key);
      expect(stillBroken[0]?.p).toBeNull();

      // An incremental pass cannot fix it either — the row is behind the cursor.
      await run(sql);
      const afterIncremental = await sql<{ sku_key: string }[]>`
        select sku_key from erp_so_line where id = ${OLD_LINE}
      `;
      expect(afterIncremental[0]?.sku_key).toBe(broken[0]?.sku_key);

      // Only re-fetching the row under today's parsing rules restores it.
      const full = await runFull(sql);
      expect(full.tables.every((t) => t.ok)).toBe(true);
      expect(full.recompute?.started).toBe(true); // the cheap step ran first, as it always does
      const repaired = await sql<{ sku_key: string; p: string | null; l: string | null }[]>`
        select sku_key, p::text as p, l::text as l from erp_so_line where id = ${OLD_LINE}
      `;
      expect(repaired[0]?.sku_key).toBe(good[0]?.sku_key);
      expect(repaired[0]?.p).toBe(good[0]?.p);
      expect(repaired[0]?.l).toBe(good[0]?.l);
    });

    it("names both repairs in the log, and says which situation each one fixes", async () => {
      await run(sql);
      await sql`update erp_so_line set sku_key = 'RETIRED|COMPOSITION' where id = ${OLD_LINE}`;

      const lines: string[] = [];
      const capture = {
        info: (m: string) => lines.push(m),
        warn: (m: string) => lines.push(m),
        error: (m: string) => lines.push(m),
      };
      const result = await runFull(sql, capture);
      expect(result.started).toBe(true);

      const all = lines.join("\n");
      expect(all).toContain("FULL RE-SYNC starting");
      expect(all).toContain("wp2.ppic"); // the actor is on the record
      expect(all).toContain("sku-key recompute: rekeyed 1 row(s) in place");
      expect(all).toContain(`cleared ${SYNC_TABLE_COUNT} stored cursor(s)`);
      // One grep-able line PER TABLE saying it is pulling with no cursor. The
      // `^<table>:` anchor is what separates them from the preamble, which names
      // the same string so an operator knows what to grep for.
      const fullPullLines = lines.filter((l) => /^[a-z_]+: pulling with updated_at__gte=\(none — full pull\)/.test(l));
      expect(fullPullLines.length).toBe(SYNC_TABLE_COUNT);
      expect(all).toContain("FULL re-sync ok");
    });
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
