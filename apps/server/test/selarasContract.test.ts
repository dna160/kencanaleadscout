/**
 * Selaras ERP — CONTRACT tests against the *verified* API specification.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every other ERP test in this repo builds its fake ERP out of what our client
 * happens to send. That can only ever prove the client is self-consistent. The
 * Selaras API documentation has now been verified against production, and the
 * assumptions the client was written from were wrong — most importantly the
 * endpoint path, which produces a 404 on *every* call.
 *
 * `selaras2.io` is unreachable from CI and from the dev sandbox (egress policy),
 * so the only way to catch a wrong URL, a wrong header name or a wrong primary
 * key before deploy is to drive the REAL client, end to end, against a mock that
 * implements the verified specification EXACTLY and refuses everything else.
 *
 * THE MOCK IS BUILT FROM THE SPEC, NOT FROM OUR CODE. It is deliberately strict:
 *
 *   - any path the spec does not define answers 404 (so a wrong URL fails loudly
 *     rather than silently returning zero rows and looking like an empty window);
 *   - a request without `X-Secret-Key` / `X-Secret-Token` answers 401;
 *   - a filter on a column the documented schema does not have answers 400.
 *
 * If our client deviates from the specification, these tests fail. That is the
 * entire point of the file: a failure here is a DEFECT REPORT about the source
 * module named in the test description, not a broken test.
 *
 * THE VERIFIED SPECIFICATION (authoritative)
 * ------------------------------------------
 *   Base URL   https://selaras2.io/kencana/api
 *              (NOT .../kencana/table_documentation — that is a human-facing SPA)
 *   Endpoints  GET /tables
 *              GET /table/{table}/columns
 *              GET /table/{table}
 *   Auth       headers `X-Secret-Key` + `X-Secret-Token` (preferred),
 *              or query `?secret_key=&secret_token=`
 *   Status     200 ok · 400 bad request · 401 bad/disabled credentials,
 *              alongside a JSON `success` boolean
 *   Envelope   { success, table, meta: { count, total, total_pages, page, limit,
 *                offset, order_by, order_dir, filters }, data: [...] }
 *   Query      limit, page|offset, order_by, order_dir, fields,
 *              col=, col__gte, col__lte, col__ne; datetimes
 *              `YYYY-MM-DD` or `YYYY-MM-DD HH:mm:ss` (WIB)
 *   Sync       ?updated_at__gte=<cursor>&order_by=updated_at&order_dir=asc
 *              &limit=1000&page=N, advancing until page >= meta.total_pages,
 *              upserting by primary key `{table}_id`
 *
 * NO NETWORK, EVER: undici's MockAgent with `disableNetConnect()` is installed
 * as the global dispatcher, so a leaked real request fails loudly.
 *
 * The DB-backed block needs a real Postgres (an upsert against a fake `Sql`
 * proves nothing about `on conflict do update`). It creates its OWN schema and
 * drops it again. With no reachable database it SKIPS with a clear message; the
 * HTTP/adapter half still runs, because that half is where the 404 lives.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MockAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
  request,
  type Dispatcher,
} from "undici";
import postgres from "postgres";

// ── Environment must be set BEFORE config.ts is evaluated ────────────────────
// config.ts freezes env into a frozen const at import time, so everything under
// test is pulled in dynamically, after these assignments.

const ORIGIN = "https://selaras2.io";
const API_PATH = "/kencana/api";
const BASE_URL = `${ORIGIN}${API_PATH}`;

/** Distinctive on purpose: assertions below grep for these exact strings. */
const SECRET_KEY = "kcn_contract_key_3f9a2b7c1d5e8f0a";
const SECRET_TOKEN = "kcn_contract_token_a1b2c3d4e5f60718";

const PAGE_SIZE = 2; // small, so multi-page paging is genuinely exercised

process.env["SELARAS_BASE_URL"] = BASE_URL;
process.env["SELARAS_SECRET_KEY"] = SECRET_KEY;
process.env["SELARAS_SECRET_TOKEN"] = SECRET_TOKEN;
process.env["SELARAS_AUTH_MODE"] = "header";
process.env["SELARAS_TIMEOUT_MS"] = "3000";
// Fixtures carry JSON numbers, which are unambiguous in every mode; `en` keeps
// the A22 ambiguity machinery out of the way of the contract assertions.
process.env["SELARAS_NUMBER_FORMAT"] = "en";
process.env["STOCK_SYNC_PAGE_SIZE"] = String(PAGE_SIZE);
process.env["STOCK_SYNC_INTERVAL_MS"] = "60000";
process.env["STOCK_APPROVED_STATUSES"] = "Approved";
process.env["STOCK_STALE_WINDOW_DAYS"] = "60";

const clientMod = await import("../src/erp/selarasClient.js");
const workerMod = await import("../src/erp/syncWorker.js");
const migrateMod = await import("../src/db/migrateErpStock.js");

const { SELARAS_ENDPOINTS, adaptLiveFgRow, adaptSoLineRow, buildPageUrl, fetchPage } = clientMod;
const { runErpSyncOnce } = workerMod;

type SelarasTable = keyof typeof SELARAS_ENDPOINTS;

// ── The verified schema, as the spec states it ───────────────────────────────

const ERP_TABLE = {
  so_header: "tbl_1202_SOSalesOrderNID",
  so_line: "tbl_1203_SOSalesOrderDetailNID",
  live_fg: "tbl_1210_STLiveFGMX",
  warna: "tbl_1228_DBRMWarnaID",
} as const;

/**
 * The verified column lists (abridged to the columns that matter). These are the
 * mock's schema: a filter on anything absent here is a 400, exactly as the real
 * API behaves for an unknown filter column.
 *
 * NOTE, because it is the whole reason the SKU key was remapped: the SO detail
 * table has **no `kode_barang` and no `th`**.
 */
const SPEC_COLUMNS: Record<string, readonly string[]> = {
  [ERP_TABLE.so_line]: [
    `${ERP_TABLE.so_line}_id`,
    `${ERP_TABLE.so_header}_id`,
    "status_order",
    "customer_name",
    "customer_name_text",
    "po_no",
    "estimate_delivery",
    "brand",
    "brand_text",
    "warna",
    "warna_text",
    "th_alu_skin",
    "total_thickness_acp",
    "batch_warna",
    "l",
    "p",
    "m2",
    "approval",
    "auto_approval",
    "sn_fg",
    "qty_order",
    "qty_delivered",
    "qty_balance",
    "sales_name",
    "sales_name_text",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  [ERP_TABLE.live_fg]: [
    `${ERP_TABLE.live_fg}_id`,
    "sn_fg",
    "qty",
    "qty_m2",
    "qty_booking",
    "buffer_qty",
    "buffer_status",
    "nama_barang",
    "brand",
    "brand_text",
    "warna",
    "warna_text",
    "kode_barang",
    "kode_warna",
    "batch_warna",
    "th",
    "t",
    "p",
    "l",
    "m2",
    "coating",
    "lokasi",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  [ERP_TABLE.so_header]: [
    `${ERP_TABLE.so_header}_id`,
    "po_no",
    "po_date",
    "customer_name",
    "customer_name_text",
    "sales_name",
    "sales_name_text",
    "status_order",
    "approval",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  [ERP_TABLE.warna]: [
    `${ERP_TABLE.warna}_id`,
    "rm_warna",
    "warna_code",
    "kode_warna",
    "kode_barang",
    // The spec's column list for this table is abridged; every Selaras table
    // carries the three audit columns, and the sync pattern orders on them.
    "created_at",
    "updated_at",
    "deleted_at",
  ],
};

/** Query parameters that are part of the query LANGUAGE, not column filters. */
const RESERVED_PARAMS = new Set([
  "limit",
  "page",
  "offset",
  "order_by",
  "order_dir",
  "fields",
  "secret_key",
  "secret_token",
]);

const FILTER_SUFFIXES = ["__gte", "__lte", "__ne"] as const;

/** `updated_at__gte` → `updated_at`; `po_no` → `po_no`. */
function filterColumn(param: string): string {
  for (const suffix of FILTER_SUFFIXES) {
    if (param.endsWith(suffix)) return param.slice(0, -suffix.length);
  }
  return param;
}

// ── Fixtures, in the REAL column vocabulary ──────────────────────────────────
//
// One SO line and one Live FG row that are genuinely the SAME product:
//   brand 7 · warna 4 (= "BLACK GALAXY") · alu skin 0.3 · panel 4 · 4880 × 1220
// The SO side spells the thicknesses `th_alu_skin` / `total_thickness_acp`; the
// FG side spells them `th` / `t`. `warna` is the numeric id, never the name.
// `sn_fg` is NULL on the SO line, which is why the join is by product identity.

const TARGET_SKU_ROW = {
  brand: 7,
  brand_text: "SEVEN",
  warna: 4,
  warna_text: "BLACK GALAXY",
  p: 4880,
  l: 1220,
} as const;

const SO_LINE_ROWS: readonly Record<string, unknown>[] = [
  {
    // LIVE demand on the target SKU: 100 lembar still owed.
    [`${ERP_TABLE.so_line}_id`]: "1203-000001",
    [`${ERP_TABLE.so_header}_id`]: "1202-000001",
    ...TARGET_SKU_ROW,
    th_alu_skin: 0.3,
    total_thickness_acp: 4,
    batch_warna: "B-77",
    m2: 5.9536,
    status_order: "Open",
    customer_name: 12,
    customer_name_text: "PT Sinar Mandiri",
    po_no: "PO-2026-0001",
    estimate_delivery: "2099-09-20",
    approval: "Approved",
    auto_approval: "N",
    sn_fg: null, // ← always null on SO lines (spec)
    qty_order: 120,
    qty_delivered: 20,
    qty_balance: 100,
    sales_name: 3,
    sales_name_text: "Budi Santoso",
    created_at: "2026-09-01 08:00:00",
    updated_at: "2026-09-02 08:00:00",
    deleted_at: null,
  },
  {
    // Fully delivered: approved, but nothing left to reserve.
    [`${ERP_TABLE.so_line}_id`]: "1203-000002",
    [`${ERP_TABLE.so_header}_id`]: "1202-000001",
    brand: 7,
    brand_text: "SEVEN",
    warna: 9,
    warna_text: "SILVER METALLIC",
    th_alu_skin: 0.3,
    total_thickness_acp: 4,
    p: 2440,
    l: 1220,
    status_order: "Closed",
    po_no: "PO-2026-0001",
    estimate_delivery: "2099-08-01",
    approval: "Approved",
    qty_order: 40,
    qty_delivered: 40,
    qty_balance: 0,
    created_at: "2026-09-01 08:05:00",
    updated_at: "2026-09-02 09:00:00",
    deleted_at: null,
  },
  {
    // SOFT-DELETED demand on the target SKU. Must NOT reserve anything: if it
    // does, ATP is understated by 500 lembar and the SKU reads as unsellable.
    [`${ERP_TABLE.so_line}_id`]: "1203-000003",
    [`${ERP_TABLE.so_header}_id`]: "1202-000001",
    ...TARGET_SKU_ROW,
    th_alu_skin: 0.3,
    total_thickness_acp: 4,
    status_order: "Open",
    po_no: "PO-2026-0001",
    estimate_delivery: "2099-09-25",
    approval: "Approved",
    qty_order: 500,
    qty_delivered: 0,
    qty_balance: 500,
    created_at: "2026-09-01 08:10:00",
    updated_at: "2026-09-02 10:00:00",
    deleted_at: "2026-09-03 11:00:00", // ← soft delete
  },
  {
    // Not approved: real demand, but it does not commit stock (ST-R7b).
    [`${ERP_TABLE.so_line}_id`]: "1203-000004",
    [`${ERP_TABLE.so_header}_id`]: "1202-000002",
    ...TARGET_SKU_ROW,
    th_alu_skin: 0.3,
    total_thickness_acp: 4,
    status_order: "Open",
    po_no: "PO-2026-0002",
    estimate_delivery: "2099-10-01",
    approval: "Pending",
    qty_order: 77,
    qty_delivered: 0,
    qty_balance: 77,
    created_at: "2026-09-01 08:15:00",
    updated_at: "2026-09-02 11:00:00",
    deleted_at: null,
  },
];

const LIVE_FG_ROWS: readonly Record<string, unknown>[] = [
  {
    // ON HAND on the target SKU: 150 lembar.
    [`${ERP_TABLE.live_fg}_id`]: "1210-000001",
    sn_fg: "FG-AAA-0001",
    ...TARGET_SKU_ROW,
    th: 0.3,
    t: 4,
    m2: 5.9536,
    qty: 150,
    qty_m2: 893.04,
    qty_booking: 0, // unused in production: 0 of 1,464 rows
    buffer_qty: 0,
    buffer_status: "NON BUFFER",
    nama_barang: "ACP SEVEN 4MM BLACK GALAXY",
    kode_barang: "ACP-4MM-BG",
    kode_warna: "BG",
    batch_warna: "B-77",
    coating: "PVDF",
    lokasi: "GD-01",
    created_at: "2026-08-20 07:00:00",
    updated_at: "2026-09-02 12:00:00",
    deleted_at: null,
  },
  {
    // SOFT-DELETED stock on the target SKU. Must NOT count as on hand: if it
    // does, on_hand reads 1,149 instead of 150 and the SKU looks promiseable.
    [`${ERP_TABLE.live_fg}_id`]: "1210-000002",
    sn_fg: "FG-DEL-0002",
    ...TARGET_SKU_ROW,
    th: 0.3,
    t: 4,
    qty: 999,
    qty_m2: 5947.2,
    qty_booking: 0,
    buffer_qty: 0,
    buffer_status: "NON BUFFER",
    nama_barang: "ACP SEVEN 4MM BLACK GALAXY",
    kode_barang: "ACP-4MM-BG",
    lokasi: "GD-01",
    created_at: "2026-08-21 07:00:00",
    updated_at: "2026-09-02 13:00:00",
    deleted_at: "2026-09-04 09:30:00", // ← soft delete
  },
  {
    // A different SKU entirely, so the join cannot pass by having one row.
    [`${ERP_TABLE.live_fg}_id`]: "1210-000003",
    sn_fg: "FG-BBB-0003",
    brand: 7,
    brand_text: "SEVEN",
    warna: 9,
    warna_text: "SILVER METALLIC",
    th: 0.3,
    t: 4,
    p: 2440,
    l: 1220,
    qty: 40,
    qty_booking: 0,
    kode_barang: "ACP-4MM-SM",
    lokasi: "GD-02",
    created_at: "2026-08-22 07:00:00",
    updated_at: "2026-09-02 14:00:00",
    deleted_at: null,
  },
];

const SO_HEADER_ROWS: readonly Record<string, unknown>[] = [
  {
    [`${ERP_TABLE.so_header}_id`]: "1202-000001",
    po_no: "PO-2026-0001",
    po_date: "2026-09-01",
    customer_name: 12,
    customer_name_text: "PT Sinar Mandiri",
    sales_name: 3,
    sales_name_text: "Budi Santoso",
    status_order: "Open",
    approval: "Approved",
    created_at: "2026-09-01 07:55:00",
    updated_at: "2026-09-02 07:55:00",
    deleted_at: null,
  },
  {
    [`${ERP_TABLE.so_header}_id`]: "1202-000002",
    po_no: "PO-2026-0002",
    po_date: "2026-09-01",
    customer_name: 14,
    customer_name_text: "CV Anugerah Jaya",
    sales_name: 3,
    sales_name_text: "Budi Santoso",
    status_order: "Open",
    approval: "Pending",
    created_at: "2026-09-01 07:56:00",
    updated_at: "2026-09-02 07:56:00",
    deleted_at: null,
  },
];

const ROWS_BY_ERP_TABLE: Record<string, readonly Record<string, unknown>[]> = {
  [ERP_TABLE.so_header]: SO_HEADER_ROWS,
  [ERP_TABLE.so_line]: SO_LINE_ROWS,
  [ERP_TABLE.live_fg]: LIVE_FG_ROWS,
  [ERP_TABLE.warna]: [
    { [`${ERP_TABLE.warna}_id`]: "1228-000004", rm_warna: "BLACK GALAXY", warna_code: "4", kode_warna: "BG", kode_barang: "ACP-4MM-BG" },
  ],
};

/** The expected canonical identity of the target SKU, on BOTH sides of the join. */
const TARGET_ON_HAND = 150;
const TARGET_COMMITTED = 100;

// ── The fake ERP — the verified specification, and nothing else ──────────────

interface RecordedRequest {
  path: string;
  url: URL;
  headers: Record<string, string>;
}

let recorded: RecordedRequest[] = [];

/** `${erpTable}:${page}` → an override the test installs deliberately. */
interface ErpFaults {
  status?: Record<string, { code: number; body: object }>;
  /** `${erpTable}:${page}` → answer 200 with `success: false` (the silent failure). */
  successFalse?: Record<string, true>;
}
let faults: ErpFaults = {};

/** Auth mode the mock enforces. `header` is what the spec documents as preferred. */
let authMode: "header" | "query" = "header";

function lowerHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i]).toLowerCase()] = String(raw[i + 1]);
  } else if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k.toLowerCase()] = Array.isArray(v) ? String(v[0]) : String(v);
    }
  }
  return out;
}

function json(statusCode: number, data: object) {
  return { statusCode, data, headers: { "content-type": "application/json" } };
}

function rowUpdatedAtMs(row: Record<string, unknown>): number {
  const raw = row["updated_at"];
  if (typeof raw !== "string") return Number.POSITIVE_INFINITY;
  const t = Date.parse(/[Zz]|[+-]\d{2}:?\d{2}$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

/**
 * The mock. Implements EXACTLY the three documented endpoints and answers 404 to
 * everything else — including `<base>/{table}`, the shape our client was built
 * against, which is the defect this whole file exists to catch.
 */
function erpRespond(rawPath: string, rawHeaders: unknown) {
  const url = new URL(rawPath, ORIGIN);
  const headers = lowerHeaders(rawHeaders);
  recorded.push({ path: rawPath, url, headers });

  // ── Auth, checked before anything else (a 401 pre-empts a 404) ────────────
  const key = authMode === "header" ? headers["x-secret-key"] : url.searchParams.get("secret_key");
  const token = authMode === "header" ? headers["x-secret-token"] : url.searchParams.get("secret_token");
  if (key !== SECRET_KEY || token !== SECRET_TOKEN) {
    return json(401, { success: false, error: "Invalid or disabled credentials" });
  }

  // ── Routing: three endpoints, all GET, read-only ──────────────────────────
  if (!url.pathname.startsWith(`${API_PATH}/`)) {
    return json(404, { success: false, error: `No route for ${url.pathname}` });
  }
  const segments = url.pathname.slice(API_PATH.length + 1).split("/").filter((s) => s !== "");

  // GET /tables
  if (segments.length === 1 && segments[0] === "tables") {
    const tables = Object.values(ERP_TABLE).map((t) => ({
      table: t,
      name: t,
      description: `mock fixture for ${t}`,
      module: "stock",
      endpoint: `${API_PATH}/table/${t}`,
      columns_endpoint: `${API_PATH}/table/${t}/columns`,
    }));
    return json(200, { success: true, total: tables.length, tables });
  }

  // Everything else must be /table/{table}[/columns]
  if (segments[0] !== "table" || segments.length < 2 || segments.length > 3) {
    return json(404, { success: false, error: `No route for ${url.pathname}` });
  }
  const table = segments[1] as string;
  const columns = SPEC_COLUMNS[table];
  if (!columns) return json(404, { success: false, error: `Unknown table '${table}'` });

  // GET /table/{table}/columns
  if (segments.length === 3) {
    if (segments[2] !== "columns") return json(404, { success: false, error: `No route for ${url.pathname}` });
    return json(200, {
      success: true,
      table,
      total: columns.length,
      columns: columns.map((c) => ({ column: c, name: c, type: "text", nullable: true })),
    });
  }

  // ── GET /table/{table} — rows ─────────────────────────────────────────────
  // 400 on a filter naming a column this table does not have.
  for (const param of url.searchParams.keys()) {
    if (RESERVED_PARAMS.has(param)) continue;
    if (!columns.includes(filterColumn(param))) {
      return json(400, { success: false, error: `Unknown filter column '${filterColumn(param)}'` });
    }
  }
  const orderBy = url.searchParams.get("order_by") ?? "created_at";
  if (!columns.includes(orderBy)) {
    return json(400, { success: false, error: `Unknown order_by column '${orderBy}'` });
  }
  const orderDir = (url.searchParams.get("order_dir") ?? "desc").toLowerCase();
  if (orderDir !== "asc" && orderDir !== "desc") {
    return json(400, { success: false, error: `Invalid order_dir '${orderDir}'` });
  }

  const limit = Number(url.searchParams.get("limit") ?? "100");
  const page = Number(url.searchParams.get("page") ?? "1");
  const faultKey = `${table}:${page}`;

  const fault = faults.status?.[faultKey];
  if (fault) return json(fault.code, fault.body);
  if (faults.successFalse?.[faultKey]) {
    // A 200 that is NOT a success. The spec carries a `success` boolean
    // *alongside* the status code precisely because this happens.
    return json(200, { success: false, table, error: "internal error building result set" });
  }

  const since = url.searchParams.get("updated_at__gte");
  const sinceMs = since === null ? Number.NEGATIVE_INFINITY : parseSpecDatetime(since);

  const all = (ROWS_BY_ERP_TABLE[table] ?? []).filter((r) => rowUpdatedAtMs(r) >= sinceMs);
  const sorted = [...all].sort((a, b) =>
    orderDir === "asc" ? rowUpdatedAtMs(a) - rowUpdatedAtMs(b) : rowUpdatedAtMs(b) - rowUpdatedAtMs(a),
  );
  const offset = url.searchParams.has("offset")
    ? Number(url.searchParams.get("offset"))
    : (page - 1) * limit;
  const slice = sorted.slice(offset, offset + limit);

  const fields = url.searchParams.get("fields");
  const projected = fields
    ? slice.map((r) => Object.fromEntries(fields.split(",").map((f) => [f.trim(), r[f.trim()] ?? null])))
    : slice;

  return json(200, {
    success: true,
    table,
    meta: {
      count: projected.length,
      total: sorted.length,
      total_pages: Math.max(1, Math.ceil(sorted.length / Math.max(1, limit))),
      page,
      limit,
      offset,
      order_by: orderBy,
      order_dir: orderDir,
      filters: since === null ? [] : [{ column: "updated_at", op: "gte", value: since }],
    },
    data: projected,
  });
}

/**
 * The documented datetime grammar: `YYYY-MM-DD` or `YYYY-MM-DD HH:mm:ss`, in
 * WIB (UTC+7). The mock ALSO accepts ISO-8601 with an explicit offset, so the
 * cursor-format question is asked by one dedicated, clearly-labelled test rather
 * than silently breaking every other assertion in the file.
 */
const SPEC_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
const SPEC_DATETIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function parseSpecDatetime(value: string): number {
  if (SPEC_DATE_ONLY_RE.test(value)) return Date.parse(`${value}T00:00:00+07:00`);
  if (SPEC_DATETIME_RE.test(value)) return Date.parse(`${value.replace(" ", "T")}+07:00`);
  const t = Date.parse(value); // tolerated: ISO-8601 with an explicit offset
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
}

function isSpecDatetime(value: string): boolean {
  return SPEC_DATE_ONLY_RE.test(value) || SPEC_DATETIME_RE.test(value);
}

let mockAgent: MockAgent;
let previousDispatcher: Dispatcher;

beforeAll(() => {
  previousDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect(); // a leaked real request fails loudly instead of hanging
  mockAgent
    .get(ORIGIN)
    // EVERY path, so an undocumented one gets a real 404 from the mock rather
    // than undici's MockNotMatchedError, which reads like a test-harness bug.
    .intercept({ path: () => true, method: "GET" })
    .reply((opts) => {
      const res = erpRespond(String(opts.path), opts.headers);
      return {
        statusCode: res.statusCode,
        data: res.data as object,
        responseOptions: { headers: res.headers },
      };
    })
    .persist();
  setGlobalDispatcher(mockAgent);
});

afterAll(async () => {
  setGlobalDispatcher(previousDispatcher);
  await mockAgent.close();
});

beforeEach(() => {
  recorded = [];
  faults = {};
  authMode = "header";
});

/** A raw, spec-shaped request that bypasses our client entirely. */
async function specRequest(path: string, opts: { auth?: boolean } = {}) {
  const res = await request(`${ORIGIN}${path}`, {
    method: "GET",
    headers:
      opts.auth === false ? {} : { "X-Secret-Key": SECRET_KEY, "X-Secret-Token": SECRET_TOKEN },
  });
  const text = await res.body.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    body = text;
  }
  return { status: res.statusCode, body: body as Record<string, unknown> };
}

// ═════════════════════════════════════════════════════════════════════════════
// 0. Mock fidelity — prove the fake ERP really is strict before trusting it
// ═════════════════════════════════════════════════════════════════════════════

describe("the mock ERP implements the verified spec, and refuses everything else", () => {
  it("serves the three documented endpoints", async () => {
    const tables = await specRequest(`${API_PATH}/tables`);
    expect(tables.status).toBe(200);
    expect(tables.body["success"]).toBe(true);

    const columns = await specRequest(`${API_PATH}/table/${ERP_TABLE.so_line}/columns`);
    expect(columns.status).toBe(200);

    const rows = await specRequest(`${API_PATH}/table/${ERP_TABLE.so_line}?limit=1`);
    expect(rows.status).toBe(200);
    expect(Array.isArray(rows.body["data"])).toBe(true);
  });

  it.each([
    ["<base>/{table} — the shape our client was built against", `${API_PATH}/${ERP_TABLE.so_line}`],
    ["<base>/tables/{table}", `${API_PATH}/tables/${ERP_TABLE.so_line}`],
    ["<base>/table/{table}/rows", `${API_PATH}/table/${ERP_TABLE.so_line}/rows`],
    ["the documentation SPA mistaken for the API root", `/kencana/table_documentation/table/${ERP_TABLE.so_line}`],
    ["<base>/table/{unknown table}", `${API_PATH}/table/tbl_9999_NoSuchTable`],
    ["<base> itself", `${API_PATH}`],
  ])("answers 404 to an undocumented path: %s", async (_name, path) => {
    const res = await specRequest(path);
    expect(res.status).toBe(404);
    expect(res.body["success"]).toBe(false);
  });

  it("answers 401 without the credential pair, and 400 on an unknown filter column", async () => {
    const unauth = await specRequest(`${API_PATH}/table/${ERP_TABLE.so_line}`, { auth: false });
    expect(unauth.status).toBe(401);

    const bad = await specRequest(`${API_PATH}/table/${ERP_TABLE.so_line}?kode_barang=ACP-4MM`);
    expect(bad.status).toBe(400);
    expect(String(bad.body["error"])).toContain("kode_barang");
  });

  it("agrees with the spec that tbl_1203 has NO kode_barang and NO th", async () => {
    const res = await specRequest(`${API_PATH}/table/${ERP_TABLE.so_line}/columns`);
    const names = (res.body["columns"] as { column: string }[]).map((c) => c.column);
    expect(names).not.toContain("kode_barang");
    expect(names).not.toContain("th");
    // …and that the columns the v2 SKU key needs really are there.
    for (const c of ["brand", "warna", "th_alu_skin", "total_thickness_acp", "p", "l"]) {
      expect(names, `tbl_1203 must expose ${c}`).toContain(c);
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 1. The 404 class — the reason this file exists
//    Owner of any failure here: apps/server/src/erp/selarasClient.ts
// ═════════════════════════════════════════════════════════════════════════════

describe("endpoint path — /{base}/table/{table}, never /{base}/{table}", () => {
  it.each(["so_header", "so_line", "live_fg"] as const)(
    "builds the documented rows path for %s",
    (table) => {
      const url = new URL(buildPageUrl(table, { since: null, page: 1, limit: 10 }));
      expect(url.origin).toBe(ORIGIN);
      expect(url.pathname).toBe(`${API_PATH}/table/${SELARAS_ENDPOINTS[table]}`);
    },
  );

  it.each(["so_header", "so_line", "live_fg"] as const)(
    "actually reaches the mock ERP for %s — no 404 anywhere in the round trip",
    async (table) => {
      const res = await fetchPage(table, { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
      if (!res.ok) {
        expect.fail(
          `fetchPage('${table}') failed with HTTP ${String(res.status)}: ${res.error}. ` +
            `Requested ${recorded.map((r) => r.url.pathname).join(", ")}; the spec path is ` +
            `${API_PATH}/table/${SELARAS_ENDPOINTS[table]}`,
        );
      }
      expect(recorded.map((r) => r.url.pathname)).toEqual([
        `${API_PATH}/table/${SELARAS_ENDPOINTS[table]}`,
      ]);
    },
  );

  it("maps our three logical tables onto ERP tables the /tables endpoint lists", async () => {
    const res = await specRequest(`${API_PATH}/tables`);
    const published = (res.body["tables"] as { table: string }[]).map((t) => t.table);
    for (const [logical, erpTable] of Object.entries(SELARAS_ENDPOINTS)) {
      expect(published, `${logical} → ${erpTable} must exist in /tables`).toContain(erpTable);
    }
    // Every table the client mirrors must be one the spec actually documents —
    // a typo'd table name is a 404 exactly like a typo'd path.
    for (const erpTable of Object.values(SELARAS_ENDPOINTS)) {
      expect(SPEC_COLUMNS, `${erpTable} is not in the verified schema`).toHaveProperty(erpTable);
    }
  });

  it("never addresses the documentation SPA as if it were the API root", () => {
    for (const table of ["so_header", "so_line", "live_fg"] as const) {
      expect(buildPageUrl(table, { since: null, page: 1, limit: 10 })).not.toContain(
        "table_documentation",
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2. Auth — the likeliest first-run failure
//    Owner of any failure here: apps/server/src/erp/selarasClient.ts (requestOnce)
// ═════════════════════════════════════════════════════════════════════════════

describe("auth — X-Secret-Key + X-Secret-Token, spelled exactly", () => {
  it("sends both headers, correctly spelled and correctly valued", async () => {
    await fetchPage("live_fg", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    const sent = recorded[0];
    expect(sent, "the client made no request at all").toBeTruthy();
    const headers = sent!.headers;
    expect(
      Object.keys(headers),
      `sent headers: ${Object.keys(headers).join(", ")} — the spec requires x-secret-key`,
    ).toContain("x-secret-key");
    expect(Object.keys(headers)).toContain("x-secret-token");
    expect(headers["x-secret-key"]).toBe(SECRET_KEY);
    expect(headers["x-secret-token"]).toBe(SECRET_TOKEN);
  });

  it("keeps the credential pair OUT of the URL in header mode", async () => {
    await fetchPage("live_fg", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    for (const r of recorded) {
      expect(r.path).not.toContain(SECRET_KEY);
      expect(r.path).not.toContain(SECRET_TOKEN);
      expect(r.url.searchParams.has("secret_key")).toBe(false);
      expect(r.url.searchParams.has("secret_token")).toBe(false);
    }
    expect(buildPageUrl("so_line", { since: null, page: 1, limit: 10 })).not.toContain(SECRET_KEY);
  });

  it("surfaces a 401 distinguishably, and does not retry it", async () => {
    faults = {
      status: {
        [`${ERP_TABLE.so_line}:1`]: {
          code: 401,
          body: { success: false, error: "Invalid or disabled credentials" },
        },
      },
    };
    const res = await fetchPage("so_line", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(401);
      expect(res.retryable).toBe(false);
      expect(res.error).not.toContain(SECRET_KEY);
      expect(res.error).not.toContain(SECRET_TOKEN);
    }
    expect(recorded, "a 401 is a configuration fault; retrying it fixes nothing").toHaveLength(1);
  });

  it("a request the mock does not consider authenticated is a 401, not silent success", async () => {
    // Proves the 401 path is reachable through the real client at all: strip the
    // credentials at the mock and the client must report the failure, not zero rows.
    authMode = "query"; // header-mode credentials no longer satisfy the mock
    const res = await fetchPage("live_fg", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok, "a 401 must never be reported as an empty page").toBe(false);
    if (!res.ok) expect(res.status).toBe(401);
  });
});

describe("auth — query mode puts the pair in the query and nowhere else", () => {
  /**
   * `config` freezes env at import, so query mode needs a genuinely fresh module
   * graph. `vi.resetModules()` + a dynamic import gives one; the module instance
   * is discarded again afterwards so the rest of the file stays in header mode.
   */
  it("sends secret_key/secret_token as query params, and NO auth headers", async () => {
    const previous = process.env["SELARAS_AUTH_MODE"];
    process.env["SELARAS_AUTH_MODE"] = "query";
    vi.resetModules();
    try {
      const queryMod = await import("../src/erp/selarasClient.js");

      const url = new URL(queryMod.buildPageUrl("so_line", { since: null, page: 1, limit: 10 }));
      expect(url.searchParams.get("secret_key")).toBe(SECRET_KEY);
      expect(url.searchParams.get("secret_token")).toBe(SECRET_TOKEN);

      authMode = "query"; // the mock now accepts ONLY query credentials
      const res = await queryMod.fetchPage("so_line", {
        since: null,
        page: 1,
        limit: PAGE_SIZE,
        retryDelayMs: 0,
      });
      expect(res.ok, "query-mode credentials must authenticate").toBe(true);

      const sent = recorded.at(-1);
      expect(sent).toBeTruthy();
      expect(sent!.url.searchParams.get("secret_key")).toBe(SECRET_KEY);
      expect(sent!.url.searchParams.get("secret_token")).toBe(SECRET_TOKEN);
      // …and the credentials live in exactly ONE place, never both.
      expect(Object.keys(sent!.headers)).not.toContain("x-secret-key");
      expect(Object.keys(sent!.headers)).not.toContain("x-secret-token");
    } finally {
      if (previous === undefined) delete process.env["SELARAS_AUTH_MODE"];
      else process.env["SELARAS_AUTH_MODE"] = previous;
      vi.resetModules();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3. Envelope + paging
//    Owner of any failure here: apps/server/src/erp/selarasClient.ts (readEnvelope)
// ═════════════════════════════════════════════════════════════════════════════

describe("response envelope — data + meta.total_pages", () => {
  it("parses `data` and `meta.total_pages` off the documented envelope", async () => {
    const res = await fetchPage("so_line", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.page.rawCount).toBe(PAGE_SIZE);
    expect(res.page.totalPages).toBe(Math.ceil(SO_LINE_ROWS.length / PAGE_SIZE));
    expect(res.page.page).toBe(1);
  });

  it("treats `success: false` on a 200 as a failure, never as an empty page", async () => {
    faults = { successFalse: { [`${ERP_TABLE.so_line}:1`]: true } };
    const res = await fetchPage("so_line", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(
      res.ok,
      "a 200 body carrying success:false is an ERP error; reading it as zero rows " +
        "advances the cursor past data that was never fetched",
    ).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4. Query construction for the incremental pattern
//    Owner of any failure here: apps/server/src/erp/selarasClient.ts (buildPageUrl)
// ═════════════════════════════════════════════════════════════════════════════

describe("incremental sync query — spelled exactly as the spec states", () => {
  const since = new Date("2026-09-02T03:00:00Z");

  it("carries updated_at__gte, order_by=updated_at, order_dir=asc, limit and page", () => {
    const url = new URL(buildPageUrl("so_line", { since, page: 3, limit: 1000 }));
    expect(url.searchParams.has("updated_at__gte")).toBe(true);
    expect(url.searchParams.get("order_by")).toBe("updated_at");
    expect(url.searchParams.get("order_dir")).toBe("asc");
    expect(url.searchParams.get("limit")).toBe("1000");
    expect(url.searchParams.get("page")).toBe("3");
  });

  it("omits the cursor entirely on a first, full pull", () => {
    const url = new URL(buildPageUrl("live_fg", { since: null, page: 1, limit: 10 }));
    expect(url.searchParams.has("updated_at__gte")).toBe(false);
  });

  it("filters and orders ONLY on columns the table actually has (else: 400)", async () => {
    // Drive every table through the client and audit what it asked for.
    for (const table of ["so_header", "so_line", "live_fg"] as const) {
      await fetchPage(table, { since, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    }
    expect(recorded.length).toBeGreaterThan(0);
    for (const r of recorded) {
      const erpTable = r.url.pathname.split("/").pop() ?? "";
      const columns = SPEC_COLUMNS[erpTable];
      expect(columns, `request went to an undocumented table: ${r.url.pathname}`).toBeTruthy();
      for (const param of r.url.searchParams.keys()) {
        if (RESERVED_PARAMS.has(param)) continue;
        expect(columns, `${erpTable} has no column '${filterColumn(param)}'`).toContain(
          filterColumn(param),
        );
      }
      const orderBy = r.url.searchParams.get("order_by");
      if (orderBy !== null) expect(columns).toContain(orderBy);
    }
  });

  it("sends a cursor that denotes an unambiguous instant", () => {
    // The dangerous shape is a LOCAL-LOOKING datetime with no offset: the spec's
    // grammar is WIB (UTC+7), so `2026-09-02 03:00:00` produced from a UTC clock
    // is read 7 hours late by the ERP and silently SKIPS every row updated in
    // between — rows no later run ever revisits, because the cursor only moves
    // forward. Whatever the grammar, the cursor must carry its own zone.
    const url = new URL(buildPageUrl("so_line", { since, page: 1, limit: 10 }));
    const cursor = url.searchParams.get("updated_at__gte") ?? "";
    expect(cursor).not.toBe("");
    const hasExplicitZone = /[Zz]|[+-]\d{2}:?\d{2}$/.test(cursor);
    const isWibGrammar = isSpecDatetime(cursor);
    expect(
      hasExplicitZone || isWibGrammar,
      `cursor '${cursor}' carries neither an explicit UTC offset nor the documented WIB grammar`,
    ).toBe(true);
    if (hasExplicitZone) {
      // …and it must denote the instant we meant, not one shifted by a zone.
      expect(parseSpecDatetime(cursor)).toBe(since.getTime());
    }
  });

  /**
   * UNVERIFIED — needs the live API, which is unreachable from CI and from this
   * sandbox (`selaras2.io` is blocked by egress policy).
   *
   * The client sends `2026-09-02T03:00:00.000Z`. The verified documentation says
   * datetimes are `YYYY-MM-DD` or `YYYY-MM-DD HH:mm:ss` in WIB, and says nothing
   * about ISO-8601 being accepted. Three outcomes are possible and only live
   * traffic can distinguish them:
   *   a) the ERP parses ISO and honours the Z  → correct, nothing to do;
   *   b) the ERP rejects it                    → 400 on the first incremental
   *      page. LOUD, and already covered by the 400 test below;
   *   c) the ERP parses it but DISCARDS the Z, reading 03:00 as WIB → the cursor
   *      lands 7 hours late and rows updated in that window are skipped for good.
   * (c) is silent and unrecoverable, so this is the highest-value thing to check
   * against the first real response. Un-skip it if the answer turns out to be
   * "WIB grammar only".
   */
  it.skip("[UNVERIFIED] expresses the cursor in the documented WIB grammar", () => {
    const url = new URL(buildPageUrl("so_line", { since, page: 1, limit: 10 }));
    expect(isSpecDatetime(url.searchParams.get("updated_at__gte") ?? "")).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5. Primary key — `{table}_id`
//    Owner of any failure here: apps/server/src/erp/selarasClient.ts (adapters)
// ═════════════════════════════════════════════════════════════════════════════

describe("primary key — rows are keyed by `{table}_id`", () => {
  it("reads tbl_1203_SOSalesOrderDetailNID_id off an SO line", () => {
    const row = adaptSoLineRow(SO_LINE_ROWS[0]);
    expect(row, "an SO line with a documented primary key must not be dropped").not.toBeNull();
    expect(row?.id).toBe("1203-000001");
  });

  it("keys EVERY mirrored table on `{table}_id`, and agrees with its adapter", () => {
    const { extractRowKey, primaryKeyField, SELARAS_KEY_FIELDS } = clientMod;

    // The reconciliation sweep projects `fields=<key>` and then compares the
    // returned key set against the mirror. If the projection field and the
    // adapter's key disagree, every mirrored row looks deleted.
    for (const table of ["so_header", "so_line", "live_fg"] as const) {
      expect(primaryKeyField(table)).toBe(`${SELARAS_ENDPOINTS[table]}_id`);
      expect(SELARAS_KEY_FIELDS[table]).toBe(primaryKeyField(table));
      expect(SPEC_COLUMNS[SELARAS_ENDPOINTS[table]]).toContain(primaryKeyField(table));
    }

    expect(extractRowKey("so_line", SO_LINE_ROWS[0])).toBe("1203-000001");
    expect(extractRowKey("so_header", SO_HEADER_ROWS[0])).toBe("1202-000001");
    expect(extractRowKey("live_fg", LIVE_FG_ROWS[0])).toBe("1210-000001");

    // …and the adapter mirrors the row under exactly that key.
    expect(adaptSoLineRow(SO_LINE_ROWS[0])?.id).toBe(extractRowKey("so_line", SO_LINE_ROWS[0]));
    expect(adaptLiveFgRow(LIVE_FG_ROWS[0])?.sn_fg).toBe(extractRowKey("live_fg", LIVE_FG_ROWS[0]));
  });

  it("keys a row that carries ONLY the documented `{table}_id` (no legacy id)", () => {
    // The fallback spellings (`id`, `detail_id`, `sn_fg`, …) must not be load
    // bearing: production rows carry `{table}_id` and nothing else.
    const { extractRowKey } = clientMod;
    const bare = {
      [`${ERP_TABLE.so_line}_id`]: "1203-000099",
      ...TARGET_SKU_ROW,
      th_alu_skin: 0.3,
      total_thickness_acp: 4,
      qty_balance: 5,
      approval: "Approved",
      updated_at: "2026-09-02 08:00:00",
      deleted_at: null,
    };
    expect(extractRowKey("so_line", bare)).toBe("1203-000099");
    expect(adaptSoLineRow(bare)?.id).toBe("1203-000099");
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6 + 7. The SKU join — the highest-stakes assertion in the file
//    Owner of any failure here: apps/server/src/erp/selarasClient.ts (skuParts)
//    and apps/server/src/erp/sku.ts (SKU_SEGMENT_SOURCES)
// ═════════════════════════════════════════════════════════════════════════════

describe("sku_key — one SO line and one FG roll of the SAME product key alike", () => {
  it("keys demand and supply identically from the REAL columns", () => {
    const line = adaptSoLineRow(SO_LINE_ROWS[0]);
    const fg = adaptLiveFgRow(LIVE_FG_ROWS[0]);
    expect(line).not.toBeNull();
    expect(fg).not.toBeNull();

    expect(
      line?.sku_key,
      "SO brand/warna/th_alu_skin/total_thickness_acp/p/l and FG brand/warna/th/t/p/l " +
        "describe the same panel. If these keys differ, every commitment falls to the " +
        "exceptions tray, open_commitment is 0 for every SKU, ATP equals on-hand, and " +
        "the entire inventory reads as promiseable.",
    ).toBe(fg?.sku_key);

    // And the key must actually carry the identity — not degrade to placeholders.
    expect(line?.sku_key).not.toMatch(/^[-|]+$/);
    expect(line?.sku_key?.split("|").filter((s) => s === "-").length).toBe(0);
  });

  it("does not key on a column tbl_1203 does not have", () => {
    // A key built from `kode_barang` or a bare `th` cannot match, because the SO
    // side has neither column — the FG row would carry a value and the SO row a
    // '-' placeholder in the same position.
    const line = adaptSoLineRow(SO_LINE_ROWS[0]);
    const fgWithoutKodeBarang = adaptLiveFgRow({ ...LIVE_FG_ROWS[0], kode_barang: null, nama_barang: null });
    expect(line?.sku_key).toBe(fgWithoutKodeBarang?.sku_key);
  });

  it("distinguishes a genuinely different product", () => {
    const other = adaptLiveFgRow(LIVE_FG_ROWS[2]);
    const line = adaptSoLineRow(SO_LINE_ROWS[0]);
    expect(other?.sku_key).not.toBe(line?.sku_key);
  });

  it("treats warna as the numeric id it is, never as the display name", () => {
    const byId = adaptLiveFgRow(LIVE_FG_ROWS[0]);
    const byName = adaptLiveFgRow({ ...LIVE_FG_ROWS[0], warna: "BLACK GALAXY" });
    expect(byId?.sku_key).not.toBe(byName?.sku_key);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8. Error classes — 400 is a client error, not a transient
//    Owner of any failure here: apps/server/src/erp/selarasClient.ts (fetchPage)
// ═════════════════════════════════════════════════════════════════════════════

describe("HTTP status handling", () => {
  it("surfaces a 400 (unknown filter column) as a client error and does NOT retry it", async () => {
    faults = {
      status: {
        [`${ERP_TABLE.so_line}:1`]: {
          code: 400,
          body: { success: false, error: "Unknown filter column 'kode_barang'" },
        },
      },
    };
    const res = await fetchPage("so_line", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(400);
      expect(res.retryable, "a 400 is our bug; retrying it just doubles the load").toBe(false);
    }
    expect(recorded).toHaveLength(1);
  });

  it("retries a 500 exactly once, then reports it as retryable", async () => {
    faults = {
      status: { [`${ERP_TABLE.so_line}:1`]: { code: 503, body: { success: false, error: "upstream" } } },
    };
    const res = await fetchPage("so_line", { since: null, page: 1, limit: PAGE_SIZE, retryDelayMs: 0 });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.status).toBe(503);
      expect(res.retryable).toBe(true);
    }
    expect(recorded).toHaveLength(2);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// The mirror + ATP, against a real Postgres
// ═════════════════════════════════════════════════════════════════════════════

const TEST_DB_URL =
  process.env["TEST_DATABASE_URL"] ??
  process.env["DATABASE_URL"] ??
  "postgres://kencana:kencana@localhost:5432/leadscout";
const TEST_SCHEMA = "selaras_contract_test";

async function connectTestDb(): Promise<postgres.Sql<{}> | null> {
  try {
    const admin = postgres(TEST_DB_URL, { max: 1, idle_timeout: 0, connect_timeout: 5, onnotice: () => {} });
    await admin`select 1`;
    await admin`drop schema if exists ${admin.unsafe(TEST_SCHEMA)} cascade`;
    await admin`create schema ${admin.unsafe(TEST_SCHEMA)}`;
    await admin.end();
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
    `[selarasContract.test] no Postgres at ${TEST_DB_URL.replace(/:\/\/[^@]*@/, "://***@")} — ` +
      "the mirror/ATP block is SKIPPED (the HTTP contract block still ran). " +
      "Set DATABASE_URL or TEST_DATABASE_URL, or start Postgres 16, to run it.",
  );
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

describe.skipIf(db === null)("mirror + ATP — the real client against a real schema", () => {
  const sql = db as postgres.Sql<{}>;

  beforeAll(async () => {
    await migrateMod.runErpStockMigrations(sql);
    const tables = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = ${TEST_SCHEMA} order by 1
    `;
    const names = tables.map((t) => t.table_name);
    for (const t of ["erp_so_header", "erp_so_line", "erp_live_fg", "erp_sync_state"]) {
      expect(names, `migration did not create ${t}`).toContain(t);
    }
  });

  afterAll(async () => {
    await sql`drop schema if exists ${sql.unsafe(TEST_SCHEMA)} cascade`;
    await sql.end();
  });

  beforeEach(async () => {
    await sql`truncate erp_so_header, erp_so_line, erp_live_fg`;
    await sql`update erp_sync_state set cursor_value = null, last_error = null, last_error_at = null, running = false, rows_synced = 0`;
  });

  const runSync = () =>
    runErpSyncOnce({ db: sql, pageSize: PAGE_SIZE, intervalMs: 60_000, log: silentLog });

  it("completes a full pull through the documented endpoints", async () => {
    const result = await runSync();
    expect(result.started).toBe(true);
    const failed = result.tables.filter((t) => !t.ok);
    expect(
      failed.map((t) => `${t.table}: ${t.error ?? "unknown"}`),
      "every table must pull cleanly from the spec-shaped mock",
    ).toEqual([]);
  });

  it("stops paging at meta.total_pages — it never asks for a page past the end", async () => {
    await runSync();
    const pagesFor = (erpTable: string) =>
      recorded
        .filter((r) => r.url.pathname === `${API_PATH}/table/${erpTable}`)
        .map((r) => Number(r.url.searchParams.get("page") ?? "1"));
    // 4 SO lines at 2/page ⇒ exactly two pages, and no third request.
    expect(pagesFor(ERP_TABLE.so_line)).toEqual([1, 2]);
    // 3 FG rows at 2/page ⇒ two pages.
    expect(pagesFor(ERP_TABLE.live_fg)).toEqual([1, 2]);
  });

  it("mirrors an SO line under its `tbl_1203_SOSalesOrderDetailNID_id`", async () => {
    await runSync();
    const rows = await sql<{ id: string }[]>`select id from erp_so_line order by id`;
    expect(rows.map((r) => r.id)).toContain("1203-000001");
  });

  it("does NOT mirror soft-deleted rows as live", async () => {
    await runSync();
    const fg = await sql<{ sn_fg: string }[]>`select sn_fg from erp_live_fg order by sn_fg`;
    expect(
      fg.map((r) => r.sn_fg),
      "FG-DEL-0002 carries a non-null deleted_at; mirroring it as live inflates on-hand by 999",
    ).not.toContain("FG-DEL-0002");

    const line = await sql<{ id: string }[]>`select id from erp_so_line order by id`;
    expect(
      line.map((r) => r.id),
      "1203-000003 carries a non-null deleted_at; keeping it reserves 500 lembar that nobody ordered",
    ).not.toContain("1203-000003");
  });

  it("REDUCES ATP for the joined SKU — demand actually meets supply", async () => {
    await runSync();

    const atp = await sql<{ sku_key: string; on_hand: string; committed: string; atp: string }[]>`
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

    const fgKey = adaptLiveFgRow(LIVE_FG_ROWS[0])?.sku_key;
    const lineKey = adaptSoLineRow(SO_LINE_ROWS[0])?.sku_key;
    expect(lineKey, "demand and supply must land on the same key before ATP can mean anything").toBe(
      fgKey,
    );

    const target = atp.find((r) => r.sku_key === fgKey);
    expect(
      target,
      `no ATP row for '${String(fgKey)}'. rows: ${JSON.stringify(atp)}`,
    ).toBeTruthy();
    expect(target?.on_hand, "only the non-deleted roll is on hand").toBe(String(TARGET_ON_HAND));
    expect(
      target?.committed,
      "exactly one approved, undelivered, non-deleted line commits this SKU",
    ).toBe(String(TARGET_COMMITTED));
    expect(target?.atp, "ATP = on_hand − open_commitment").toBe(
      String(TARGET_ON_HAND - TARGET_COMMITTED),
    );
    expect(
      Number(target?.atp),
      "if ATP still equals on-hand, the commitment never matched and the SKU reads as fully promiseable",
    ).toBeLessThan(TARGET_ON_HAND);
  });

  it("does not advance the cursor when a page comes back `success: false`", async () => {
    faults = { successFalse: { [`${ERP_TABLE.so_line}:1`]: true } };
    await runSync();
    const state = await sql<{ table_name: string; cursor_value: Date | null }[]>`
      select table_name, cursor_value from erp_sync_state where table_name = 'so_line'
    `;
    expect(
      state[0]?.cursor_value,
      "a success:false page fetched no rows; advancing past it loses them forever",
    ).toBeNull();
  });
});
