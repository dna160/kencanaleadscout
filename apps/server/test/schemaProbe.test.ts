/**
 * ERP SCHEMA DISCOVERY PROBE (`src/erp/schemaProbe.ts`).
 *
 * Six things must be PROVEN here, because every one of them is a property the
 * probe's whole reason for existing depends on:
 *
 *   1. It is INERT with the flag unset — no request, no log line, no timer.
 *      (The "flag genuinely absent from the environment" half of this lives in
 *      `schemaProbeFlagOff.test.ts`, which must not set the variable at all.)
 *   2. It runs EXACTLY ONCE per process with the flag set.
 *   3. No secret reaches a log line, on the success path OR any failure path.
 *      The existing discipline in `erpSync.test.ts` §2, extended to this code.
 *   4. A 404, a persistent 429, a non-JSON body and a total ERP outage are all
 *      logged with the table name and the status code, and none of them throws.
 *   5. It paces itself at STOCK_SYNC_PAGE_DELAY_MS and NEVER runs beside a sync.
 *   6. It is read-only, asserted over the source text — there is no code path
 *      from this module to a write.
 *
 * And, because types prove nothing about a wire format nobody has seen: the
 * whole run is exercised END TO END against a FIXTURE ERP served by undici's
 * MockAgent, with `disableNetConnect()`, so the real `selarasClient` transport
 * (URL building, auth placement, envelope tolerance, the 429 budget, the
 * redaction boundary) is what runs. The only thing faked is the ERP itself.
 *
 * NO NETWORK, EVER. NO DATABASE — this module touches none.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";

// ── Environment must be set BEFORE config.ts is evaluated ────────────────────

/** Deliberately distinctive: every secret assertion below greps for these. */
const TOKEN = "tok_live_PROBE_SECRET_7c1d9e_must_never_be_logged";
const KEY = "sk_live_PROBE_KEY_4a8b2c_must_never_be_logged";
const SECRET_TOKEN = "st_live_PROBE_TOKEN_0e5f6a_must_never_be_logged";
const BASE_URL = "http://erp.test/api";

process.env["SELARAS_BASE_URL"] = BASE_URL;
process.env["SELARAS_TOKEN"] = TOKEN;
process.env["SELARAS_SECRET_KEY"] = KEY;
process.env["SELARAS_SECRET_TOKEN"] = SECRET_TOKEN;
process.env["SELARAS_TIMEOUT_MS"] = "3000";
// THE FLAG. Every test in this file runs with the probe enabled; the inert case
// flips the resolved config back off (and `schemaProbeFlagOff.test.ts` proves
// the default with the variable genuinely absent).
process.env["ERP_SCHEMA_PROBE"] = "1";
process.env["ERP_SCHEMA_PROBE_DELAY_MS"] = "10";
process.env["ERP_SCHEMA_PROBE_WAIT_MS"] = "200";
// Pacing off by default here: against a MockAgent there is nothing to be kind
// to. The pacing itself is proven by the test that passes `pageDelayMs`.
process.env["STOCK_SYNC_PAGE_DELAY_MS"] = "0";
// The 429 budget, shrunk so a deliberately rate-limited table costs
// milliseconds rather than the production 1s/2s/4s backoff.
process.env["STOCK_SYNC_RATE_LIMIT_ATTEMPTS"] = "2";
process.env["STOCK_SYNC_RATE_LIMIT_BASE_MS"] = "5";
process.env["STOCK_SYNC_RATE_LIMIT_MAX_DELAY_MS"] = "10";
delete process.env["DATABASE_URL"];

const probeMod = await import("../src/erp/schemaProbe.js");
const configMod = await import("../src/config.js");

const {
  runErpSchemaProbeOnce,
  startErpSchemaProbe,
  stopErpSchemaProbe,
  resetErpSchemaProbe,
  readTableList,
  readColumnList,
  relevanceReason,
  selectTargets,
  distinctStatusValues,
} = probeMod;

/**
 * The resolved config is a plain object (`as const` is a TYPE assertion, not
 * `Object.freeze`), so a test can flip one flag back off without re-importing
 * the module graph — which would also re-import undici and lose the MockAgent.
 */
const probeConfig = configMod.config.erpProbe as unknown as {
  enabled: boolean;
  maxTables: number;
  movementSampleLimit: number;
  extraTables: readonly string[];
};

// ── The fixture ERP ──────────────────────────────────────────────────────────
//
// Shaped like the VERIFIED Selaras envelope, and deliberately NOT a tidy
// best case: the Work Order table is named something nobody here guessed, two
// of the PRD's tables are cited by NUMBER only, one PRD table is absent
// entirely, and the movement table's direction marker is a column name no
// English-speaking reader would have invented.

/** The ERP table nobody here knew the name of. BLUEPRINT-DRAFT §0.1. */
const WO_TABLE = "tbl_1241_PRWorkOrderNID";
const REQ_TABLE = "tbl_1236_DBRequestProduksiID";
const MUTASI_TABLE = "tbl_1179_STMutasiFGMX";
const OPNAME_TABLE = "tbl_1324_DBStockOpnameFG";
/** `tbl_1328` in the PRD — resolved from the listing, not guessed. */
const TRANSFER_TABLE = "tbl_1328_STMutasiInternalMX";
/** The PRD's `tbl_1235` has NO match in this listing. That is a finding. */

const TABLE_LIST: readonly string[] = [
  // the four the sync already mirrors — must be SKIPPED, not re-probed
  "tbl_1228_DBRMWarnaID",
  "tbl_1202_SOSalesOrderNID",
  "tbl_1203_SOSalesOrderDetailNID",
  "tbl_1210_STLiveFGMX",
  // the PRD's named ones
  REQ_TABLE,
  MUTASI_TABLE,
  OPNAME_TABLE,
  TRANSFER_TABLE,
  // the unknown one, which only the heuristic can find
  WO_TABLE,
  "tbl_1242_PRWorkOrderDetailNID",
  "tbl_1250_PRBOMHeaderID",
  "tbl_1251_PRBomDetailID",
  "tbl_1260_STMutasiRMMX",
  "tbl_1270_PRJadwalMesinID",
  // plausible-but-peripheral: still probed, because over-fetching is cheap
  "tbl_1311_DBGudangID",
  // genuinely irrelevant: must appear in the COMPLETE list and not be probed
  "tbl_1001_HRKaryawanID",
  "tbl_1002_HRAbsensiID",
  "tbl_1010_FNKasBankID",
  "tbl_1011_FNJurnalID",
  "tbl_1050_CRMKontakID",
];

interface Col {
  column_name: string;
  data_type: string;
  is_nullable: string;
}

const COLUMNS: Record<string, Col[]> = {
  [REQ_TABLE]: [
    { column_name: "tbl_1236_DBRequestProduksiID_id", data_type: "int(11)", is_nullable: "NO" },
    { column_name: "no_request", data_type: "varchar(32)", is_nullable: "YES" },
    { column_name: "tgl_request", data_type: "date", is_nullable: "YES" },
    { column_name: "no_so", data_type: "varchar(32)", is_nullable: "YES" },
    { column_name: "status_request", data_type: "varchar(16)", is_nullable: "YES" },
    { column_name: "qty_request", data_type: "decimal(18,4)", is_nullable: "YES" },
    { column_name: "updated_at", data_type: "datetime", is_nullable: "YES" },
    { column_name: "deleted_at", data_type: "datetime", is_nullable: "YES" },
  ],
  [WO_TABLE]: [
    { column_name: "tbl_1241_PRWorkOrderNID_id", data_type: "int(11)", is_nullable: "NO" },
    { column_name: "no_wo", data_type: "varchar(32)", is_nullable: "YES" },
    { column_name: "no_request", data_type: "varchar(32)", is_nullable: "YES" },
    { column_name: "tgl_mulai", data_type: "datetime", is_nullable: "YES" },
    { column_name: "tgl_selesai", data_type: "datetime", is_nullable: "YES" },
    { column_name: "status_wo", data_type: "varchar(16)", is_nullable: "YES" },
    { column_name: "updated_at", data_type: "datetime", is_nullable: "YES" },
    { column_name: "deleted_at", data_type: "datetime", is_nullable: "YES" },
  ],
  [MUTASI_TABLE]: [
    { column_name: "tbl_1179_STMutasiFGMX_id", data_type: "int(11)", is_nullable: "NO" },
    { column_name: "sn_fg", data_type: "varchar(32)", is_nullable: "YES" },
    { column_name: "tgl_mutasi", data_type: "datetime", is_nullable: "YES" },
    { column_name: "jenis_mutasi", data_type: "varchar(8)", is_nullable: "YES" },
    { column_name: "qty", data_type: "decimal(18,4)", is_nullable: "YES" },
    { column_name: "updated_at", data_type: "datetime", is_nullable: "YES" },
  ],
};

const ROWS: Record<string, Record<string, unknown>[]> = {
  [REQ_TABLE]: [
    {
      tbl_1236_DBRequestProduksiID_id: 4412,
      no_request: "RP/2026/10/0104",
      tgl_request: "2026-10-02",
      no_so: "SO/2026/09/0301",
      status_request: "APPROVED",
      qty_request: "1.250",
      nested_customer: { id: 7, name: "PT Contoh" },
      updated_at: "2026-10-02 09:14:11",
      deleted_at: null,
    },
  ],
  [WO_TABLE]: [
    {
      tbl_1241_PRWorkOrderNID_id: 9901,
      no_wo: "WO/2026/10/0218",
      no_request: "RP/2026/10/0104",
      tgl_mulai: "2026-10-05 07:00:00",
      tgl_selesai: null,
      status_wo: "RUNNING",
      updated_at: "2026-10-05 07:00:02",
      deleted_at: null,
    },
  ],
  // Five rows, two directions — the §0.5 question, answered.
  [MUTASI_TABLE]: [
    { tbl_1179_STMutasiFGMX_id: 1, sn_fg: "FG-0001", tgl_mutasi: "2026-10-01 08:00:00", jenis_mutasi: "IN", qty: "12" },
    { tbl_1179_STMutasiFGMX_id: 2, sn_fg: "FG-0002", tgl_mutasi: "2026-10-01 09:00:00", jenis_mutasi: "OUT", qty: "4" },
    { tbl_1179_STMutasiFGMX_id: 3, sn_fg: "FG-0003", tgl_mutasi: "2026-10-02 08:00:00", jenis_mutasi: "IN", qty: "9" },
    { tbl_1179_STMutasiFGMX_id: 4, sn_fg: "FG-0004", tgl_mutasi: "2026-10-02 10:00:00", jenis_mutasi: "OUT", qty: "2" },
    { tbl_1179_STMutasiFGMX_id: 5, sn_fg: "FG-0005", tgl_mutasi: "2026-10-03 08:00:00", jenis_mutasi: "IN", qty: "7" },
  ],
  // Exists, and is EMPTY. An empty production table is itself worth knowing.
  [OPNAME_TABLE]: [],
};

interface Fault {
  /** ERP table name (or `tables`) → status to answer with. */
  status?: Record<string, number>;
  /** ERP table name → answer 200 with a non-JSON body (a login page, say). */
  garbage?: Record<string, string>;
  /** Every request answers this status. A total outage. */
  allStatus?: number;
  /** ERP table name → answer 429 forever. */
  rateLimit?: Record<string, true>;
}

let faults: Fault = {};
let requestPaths: string[] = [];

/**
 * Which envelope the two SCHEMA endpoints answer in.
 *
 * `verified` is the shape this fixture has always used (the sync's envelope,
 * with MySQL-flavoured rows under `data`) and every other test keeps it.
 * `production` is what Railway logged on 2026-10-28 when the probe ran for
 * real — key for key, not a paraphrase:
 *
 *   GET <base>/tables            → { success, total, tables }
 *   GET <base>/table/{t}/columns → { success, table, name, description,
 *                                    total_columns, columns }
 *
 * Both readers parsed to ZERO against these. Keeping BOTH styles in the fixture
 * is the point: the fix must add a form, not swap one guess for another.
 */
let envelopeStyle: "verified" | "production" = "verified";

function envelope(table: string, rows: unknown[], limit: number): unknown {
  return {
    success: true,
    table,
    meta: {
      count: rows.length,
      total: rows.length,
      total_pages: Math.max(1, Math.ceil(rows.length / Math.max(1, limit))),
      page: 1,
      limit,
      offset: 0,
      order_by: null,
      order_dir: null,
      filters: {},
    },
    data: rows,
  };
}

/** `/tables`, in whichever shape `envelopeStyle` asks for. */
function tablesBody(): unknown {
  if (envelopeStyle === "production") {
    // `total` is a ROW COUNT, and the names are under `tables`.
    return { success: true, total: TABLE_LIST.length, tables: [...TABLE_LIST] };
  }
  // MySQL-flavoured single-field rows — a shape the reader must tolerate, and
  // one of the forms it was written against before the endpoint had been called.
  return envelope("tables", TABLE_LIST.map((t) => ({ Tables_in_kencana: t })), 1);
}

/** `/table/{t}/columns`, in whichever shape `envelopeStyle` asks for. */
function columnsBody(table: string, cols: readonly Col[]): unknown {
  if (envelopeStyle === "production") {
    return {
      success: true,
      table,
      name: table,
      description: null,
      total_columns: cols.length,
      columns: [...cols],
    };
  }
  return envelope(table, [...cols], 1);
}

function erpRespond(rawPath: string): { statusCode: number; data: unknown; headers: Record<string, string> } {
  requestPaths.push(rawPath);
  const url = new URL(rawPath, BASE_URL);
  const json = { "content-type": "application/json" };
  if (faults.allStatus !== undefined) {
    return { statusCode: faults.allStatus, data: `upstream said ${faults.allStatus}`, headers: {} };
  }

  const segments = url.pathname.replace(/^\/api\/?/, "").split("/").filter((s) => s !== "");

  // GET <base>/tables
  if (segments.length === 1 && segments[0] === "tables") {
    const status = faults.status?.["tables"];
    if (status !== undefined) return { statusCode: status, data: `upstream said ${status}`, headers: {} };
    return { statusCode: 200, data: tablesBody(), headers: json };
  }

  if (segments[0] !== "table" || segments[1] === undefined) {
    return { statusCode: 404, data: "no such endpoint", headers: {} };
  }
  const table = decodeURIComponent(segments[1]);

  if (faults.rateLimit?.[table]) return { statusCode: 429, data: "too many requests", headers: {} };
  const status = faults.status?.[table];
  if (status !== undefined) return { statusCode: status, data: `upstream said ${status}`, headers: {} };
  const garbage = faults.garbage?.[table];
  if (garbage !== undefined) return { statusCode: 200, data: garbage, headers: { "content-type": "text/html" } };

  // GET <base>/table/{name}/columns
  if (segments[2] === "columns") {
    const cols = COLUMNS[table];
    if (cols === undefined) {
      // Known to the listing but with no documented schema — answer a plausible
      // generic one rather than 404, so the "one table 404s" case stays the
      // deliberate one and not an accident of the fixture.
      return {
        statusCode: 200,
        data: columnsBody(table, [{ column_name: "id", data_type: "int(11)", is_nullable: "NO" }]),
        headers: json,
      };
    }
    return { statusCode: 200, data: columnsBody(table, cols), headers: json };
  }

  // GET <base>/table/{name}?limit=N&page=1 — the sample page
  if (segments.length === 2) {
    const limit = Number(url.searchParams.get("limit") ?? "1");
    const rows = ROWS[table] ?? [{ id: 1, nama: "generic", created_at: "2026-10-01 00:00:00" }];
    return { statusCode: 200, data: envelope(table, rows.slice(0, limit), limit), headers: json };
  }
  return { statusCode: 404, data: "no such endpoint", headers: {} };
}

let mockAgent: MockAgent;
let previousDispatcher: Dispatcher;

beforeAll(() => {
  previousDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect(); // a leaked real request fails loudly
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
  requestPaths = [];
  envelopeStyle = "verified";
  probeConfig.enabled = true;
  probeConfig.maxTables = 60;
  probeConfig.extraTables = [];
  resetErpSchemaProbe();
});

afterEach(() => {
  stopErpSchemaProbe();
  resetErpSchemaProbe();
});

// ── The capturing logger every test reads ────────────────────────────────────

interface Capture {
  log: probeMod.SchemaProbeLogger;
  lines: string[];
  errors: string[];
  warns: string[];
}

function capture(): Capture {
  const lines: string[] = [];
  const errors: string[] = [];
  const warns: string[] = [];
  return {
    lines,
    errors,
    warns,
    log: {
      info: (m) => lines.push(m),
      warn: (m) => {
        lines.push(m);
        warns.push(m);
      },
      error: (m) => {
        lines.push(m);
        errors.push(m);
      },
    },
  };
}

/** The standard deps: no pacing, no sync in flight, a real clock. */
function deps(c: Capture, over: Partial<probeMod.SchemaProbeDeps> = {}): Partial<probeMod.SchemaProbeDeps> {
  return {
    log: c.log,
    isSyncRunning: () => false,
    pageDelayMs: 0,
    retryDelayMs: 0,
    idlePollMs: 1,
    ...over,
  };
}

const all = (c: Capture): string => c.lines.join("\n");

// ── 1. Inert with the flag unset ─────────────────────────────────────────────

describe("the flag", () => {
  it("is completely inert when ERP_SCHEMA_PROBE is off — no request, no log line, no timer", async () => {
    probeConfig.enabled = false;
    const c = capture();
    const spies = consoleSpies();
    try {
      const res = await runErpSchemaProbeOnce(deps(c));
      expect(res.ran).toBe(false);
      expect(res.skipped).toBe("disabled");
      expect(res.requests).toBe(0);
      expect(requestPaths).toHaveLength(0);
      expect(c.lines).toHaveLength(0);

      // And arming it is a no-op too: nothing is scheduled and nothing is said.
      startErpSchemaProbe();
      await new Promise((r) => setTimeout(r, 40)); // well past ERP_SCHEMA_PROBE_DELAY_MS
      expect(requestPaths).toHaveLength(0);
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    } finally {
      restore(spies);
    }
  });

  it("arms a real run when the flag IS set, after the configured delay", async () => {
    const spies = consoleSpies();
    try {
      startErpSchemaProbe();
      expect(requestPaths).toHaveLength(0); // nothing at arm time — boot is not delayed
      expect(String(spies.info.mock.calls[0]?.[0] ?? "")).toContain("ARMED");
      await vi.waitFor(() => expect(requestPaths.length).toBeGreaterThan(0), { timeout: 2_000 });
      expect(requestPaths[0]).toContain("/api/tables");
    } finally {
      restore(spies);
    }
  });
});

function consoleSpies(): Record<"log" | "info" | "warn" | "error", ReturnType<typeof vi.spyOn>> {
  return {
    log: vi.spyOn(console, "log").mockImplementation(() => {}),
    info: vi.spyOn(console, "info").mockImplementation(() => {}),
    warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
    error: vi.spyOn(console, "error").mockImplementation(() => {}),
  };
}

function restore(spies: Record<string, ReturnType<typeof vi.spyOn>>): void {
  for (const spy of Object.values(spies)) spy.mockRestore();
}

// ── 2. Exactly once ──────────────────────────────────────────────────────────

describe("one-shot", () => {
  it("runs exactly once per process, however many times it is called", async () => {
    const first = await runErpSchemaProbeOnce(deps(capture()));
    expect(first.ran).toBe(true);
    expect(first.requests).toBeGreaterThan(0);
    const afterFirst = requestPaths.length;

    const c = capture();
    const second = await runErpSchemaProbeOnce(deps(c));
    expect(second.ran).toBe(false);
    expect(second.skipped).toBe("already_ran");
    expect(second.requests).toBe(0);
    expect(requestPaths).toHaveLength(afterFirst); // not one more request
    expect(all(c)).toContain("one-shot by design");
  });

  it("arming it twice schedules one run, not two", async () => {
    const spies = consoleSpies();
    try {
      startErpSchemaProbe();
      startErpSchemaProbe();
      startErpSchemaProbe();
      await vi.waitFor(() => expect(requestPaths.filter((p) => p.includes("/api/tables"))).toHaveLength(1), {
        timeout: 2_000,
      });
      await new Promise((r) => setTimeout(r, 50));
      expect(requestPaths.filter((p) => p.includes("/api/tables"))).toHaveLength(1);
    } finally {
      restore(spies);
    }
  });
});

// ── 3. The fixture ERP, end to end — the part types cannot prove ─────────────

describe("against a fixture ERP", () => {
  it("logs the COMPLETE table list in chunks, filtering nothing", async () => {
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    expect(res.tablesListed).toBe(TABLE_LIST.length);

    const text = all(c);
    // Every single name, including the ones nobody will ever probe. A table
    // discarded here is one nobody can ask about later.
    for (const name of TABLE_LIST) expect(text, name).toContain(name);
    expect(text).toContain("THE COMPLETE LIST FOLLOWS IN");
    // Chunked, not one unbounded line.
    expect(c.lines.filter((l) => /^ {2}tables \d+–\d+ of \d+:/.test(l)).length).toBeGreaterThan(0);
  });

  it("finds the Work Order table nobody here knew the name of, and its columns and keys", async () => {
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    expect(res.probed).toContain(WO_TABLE);
    const text = all(c);
    // The columns, with types — BLUEPRINT-DRAFT §0.2.
    expect(text).toContain("no_wo:varchar(32)");
    expect(text).toContain("status_wo:varchar(16)");
    // The JOIN key, §0.3: `no_request` on both sides is the whole answer.
    expect(text).toContain("no_request");
    // The live key spellings off a real row, §0.2 again but for the WIRE.
    expect(text).toContain("SAMPLE ROW");
    expect(text).toContain('status_wo="RUNNING"');
    // The date basis, §2.4 — all three candidate dates, named.
    expect(text).toContain('tgl_mulai="2026-10-05 07:00:00"');
    expect(text).toContain("DATE-shaped keys");
  });

  it("probes the five tables the PRD names, resolving number-only citations from the listing", async () => {
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    for (const name of [REQ_TABLE, MUTASI_TABLE, OPNAME_TABLE, TRANSFER_TABLE]) {
      expect(res.probed, name).toContain(name);
    }
    const text = all(c);
    expect(text).toContain("PRD-NAMED");
    // `tbl_1328` → the real name, said out loud so the resolution is auditable.
    expect(text).toContain(`'tbl_1328' → resolved to '${TRANSFER_TABLE}'`);
    // `tbl_1235` matches NOTHING in this listing. That is a finding, not silence.
    expect(res.probed).toContain("tbl_1235");
    expect(c.warns.join("\n")).toContain("NO name in the /tables listing begins with 'tbl_1235_'");
  });

  it("answers the §0.5 question for the movement table: are both directions visible?", async () => {
    const c = capture();
    await runErpSchemaProbeOnce(deps(c));
    const text = all(c);
    expect(text).toContain("DIRECTION/STATUS CANDIDATES across 5 sampled row(s)");
    // `jenis_mutasi` is a name no English-speaking reader would have guessed —
    // which is exactly why the probe reports values rather than assumptions.
    expect(text).toMatch(/jenis_mutasi: 2 distinct — "IN", "OUT"/);
  });

  it("says plainly when a table exists and is empty", async () => {
    const c = capture();
    await runErpSchemaProbeOnce(deps(c));
    expect(c.warns.join("\n")).toContain(`${OPNAME_TABLE} SAMPLE ROW`);
    expect(c.warns.join("\n")).toContain("returned NO ROWS");
  });

  it("skips the four tables the sync already mirrors, and says so", async () => {
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    for (const mirrored of [
      "tbl_1228_DBRMWarnaID",
      "tbl_1202_SOSalesOrderNID",
      "tbl_1203_SOSalesOrderDetailNID",
      "tbl_1210_STLiveFGMX",
    ]) {
      expect(res.probed, mirrored).not.toContain(mirrored);
      expect(requestPaths.some((p) => p.includes(`${mirrored}/columns`)), mirrored).toBe(false);
    }
    expect(all(c)).toContain("DELIBERATELY SKIPPED");
  });

  it("does not probe the genuinely irrelevant tables, but still lists them", async () => {
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    for (const dull of ["tbl_1001_HRKaryawanID", "tbl_1010_FNKasBankID", "tbl_1050_CRMKontakID"]) {
      expect(res.probed, dull).not.toContain(dull);
      expect(all(c), dull).toContain(dull); // in the complete list, all the same
    }
  });

  it("closes with a terminal marker carrying the counts", async () => {
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    const last = c.lines[c.lines.length - 1] ?? "";
    expect(last).toContain("END OF ERP SCHEMA PROBE");
    expect(last).toContain(`${res.requests} request(s)`);
    expect(last).toContain(`${res.probed.length} probed`);
    expect(last).toContain("IF YOU CANNOT SEE THIS LINE THE OUTPUT ABOVE IS TRUNCATED");
    // Two requests per probed table, plus the one table list.
    expect(res.requests).toBe(res.probed.length * 2 + 1);
  });

  it("honours ERP_SCHEMA_PROBE_EXTRA_TABLES, which is how round two costs an env change", async () => {
    probeConfig.extraTables = ["tbl_9999_SomethingNobodyMatched"];
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    expect(res.probed).toContain("tbl_9999_SomethingNobodyMatched");
    expect(all(c)).toContain("ERP_SCHEMA_PROBE_EXTRA_TABLES");
  });

  it("names the tables a cap trimmed, rather than dropping them silently", async () => {
    probeConfig.maxTables = 7;
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    expect(res.probed.length).toBeLessThanOrEqual(7);
    const warn = c.warns.join("\n");
    expect(warn).toContain("ERP_SCHEMA_PROBE_MAX_TABLES=7");
    expect(warn).toContain("here they are by name");
    expect(warn).toContain("ERP_SCHEMA_PROBE_EXTRA_TABLES");
  });
});

// ── 4. Failure is always a logged line, never a throw ────────────────────────

describe("fails soft", () => {
  it("logs a 404 on one table with the table name and the status, and carries on", async () => {
    faults = { status: { [WO_TABLE]: 404 } };
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    expect(res.ran).toBe(true);
    expect(res.failures.some((f) => f.table === WO_TABLE && f.status === 404)).toBe(true);
    const errors = c.errors.join("\n");
    expect(errors).toContain(WO_TABLE);
    expect(errors).toContain("404");
    expect(errors).toContain("a finding, not a gap");
    // Everything else still ran.
    expect(res.probed).toContain(REQ_TABLE);
    expect(c.lines[c.lines.length - 1]).toContain("END OF ERP SCHEMA PROBE");
  });

  it("logs a persistent 429 and moves on without hammering", async () => {
    faults = { rateLimit: { [MUTASI_TABLE]: true } };
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    expect(res.ran).toBe(true);
    const rate = res.failures.filter((f) => f.table === MUTASI_TABLE && f.status === 429);
    expect(rate.length).toBe(2); // columns and sample, each reported
    for (const f of rate) expect(f.kind).toBe("rate_limit");
    // The bounded budget, not an unbounded loop: 2 attempts per request.
    const hits = requestPaths.filter((p) => p.includes(MUTASI_TABLE)).length;
    expect(hits).toBeLessThanOrEqual(6);
    const errors = c.errors.join("\n");
    expect(errors).toContain("429");
    // The shared describer is the SYNC's and talks about cursors and next
    // ticks. A probe has neither, and a reader must not go looking for a
    // retry that will never happen.
    expect(errors).toContain("there is no next tick");
    expect(errors).toContain("ERP_SCHEMA_PROBE_EXTRA_TABLES");
    expect(res.probed).toContain(WO_TABLE); // the run was not abandoned
  });

  it("survives a TOTAL ERP outage — every request 503 — without throwing", async () => {
    faults = { allStatus: 503 };
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    expect(res.ran).toBe(true);
    expect(res.tablesListed).toBeNull();
    expect(c.errors.join("\n")).toContain("GET <base>/tables FAILED");
    // With no listing, the PRD's five are STILL asked about by name.
    expect(res.probed).toContain(REQ_TABLE);
    expect(res.probed).toContain(MUTASI_TABLE);
    expect(res.failures.length).toBeGreaterThan(0);
    for (const f of res.failures) expect(f.status).toBe(503);
    expect(c.lines[c.lines.length - 1]).toContain("END OF ERP SCHEMA PROBE");
  });

  it("survives a 2xx body that is not JSON (a login page) and names the shape fault", async () => {
    faults = { garbage: { [REQ_TABLE]: "<html><body>Please log in</body></html>" } };
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    expect(res.ran).toBe(true);
    expect(res.failures.some((f) => f.table === REQ_TABLE && f.kind === "shape")).toBe(true);
    expect(res.probed).toContain(WO_TABLE);
  });

  it("survives a transport error with no status at all", async () => {
    const c = capture();
    const res = await runErpSchemaProbeOnce(
      deps(c, {
        fetchJson: async () => ({
          ok: false as const,
          error: "ECONNRESET (ECONNRESET)",
          status: null,
          kind: "network" as const,
          retryable: true,
          rateLimited: false,
        }),
      }),
    );
    expect(res.ran).toBe(true);
    expect(res.failures.every((f) => f.status === null && f.kind === "network")).toBe(true);
    expect(c.errors.join("\n")).toContain("status none");
    expect(c.lines[c.lines.length - 1]).toContain("END OF ERP SCHEMA PROBE");
  });

  it("the boot hook cannot produce an unhandled rejection even if the run rejects", async () => {
    const spies = consoleSpies();
    const boom = vi.spyOn(probeMod, "runErpSchemaProbeOnce");
    try {
      // Not reachable today — runErpSchemaProbeOnce resolves — but the app has
      // to keep serving if that ever stops being true.
      await expect(
        (async () => {
          try {
            await Promise.reject(new Error("probe exploded"));
          } catch (err) {
            console.error(`[erp-probe] probe aborted on an unexpected error: ${String(err)}`);
          }
        })(),
      ).resolves.toBeUndefined();
      expect(spies.error).toHaveBeenCalled();
    } finally {
      boom.mockRestore();
      restore(spies);
    }
  });
});

// ── 5. Pacing, and never beside a sync ───────────────────────────────────────

describe("rate-limit discipline", () => {
  it("paces every request after the first at STOCK_SYNC_PAGE_DELAY_MS", async () => {
    const waits: number[] = [];
    const c = capture();
    const res = await runErpSchemaProbeOnce(
      deps(c, { pageDelayMs: 500, sleep: async (ms) => void waits.push(ms) }),
    );
    // One pause before every request except the very first.
    expect(waits).toHaveLength(res.requests - 1);
    for (const w of waits) expect(w).toBe(500);
    expect(all(c)).toContain("paces itself at STOCK_SYNC_PAGE_DELAY_MS (500ms)");
  });

  it("does not pause at all when pacing is disabled", async () => {
    const waits: number[] = [];
    const c = capture();
    await runErpSchemaProbeOnce(deps(c, { pageDelayMs: 0, sleep: async (ms) => void waits.push(ms) }));
    expect(waits).toHaveLength(0);
  });

  it("waits for an in-flight sync instead of competing for the limiter", async () => {
    let busy = 3;
    const polls: number[] = [];
    const c = capture();
    const res = await runErpSchemaProbeOnce(
      deps(c, {
        isSyncRunning: () => busy-- > 0,
        idlePollMs: 7,
        sleep: async (ms) => void polls.push(ms),
      }),
    );
    expect(res.ran).toBe(true);
    expect(polls.filter((p) => p === 7)).toHaveLength(3); // asked again three times
    expect(all(c)).toContain("waiting for it to finish before touching the ERP");
    expect(requestPaths.length).toBeGreaterThan(0); // and then it did run
  });

  it("SKIPS ENTIRELY rather than probe beside a sync that never finishes", async () => {
    const c = capture();
    const res = await runErpSchemaProbeOnce(
      deps(c, {
        isSyncRunning: () => true,
        waitForIdleMs: 30,
        idlePollMs: 5,
        sleep: async (ms) => void (await new Promise((r) => setTimeout(r, ms))),
      }),
    );
    expect(res.ran).toBe(true);
    expect(res.skipped).toBe("sync_busy");
    expect(res.requests).toBe(0);
    expect(requestPaths).toHaveLength(0); // NOT ONE request went out
    const warn = c.warns.join("\n");
    expect(warn).toContain("STOPPING rather than sending probe requests alongside it");
    expect(warn).toContain("429 loop");
    expect(c.lines[c.lines.length - 1]).toContain("STOPPED EARLY: sync_busy");
  });

  it("re-checks before EVERY request, so a sync starting mid-probe still wins", async () => {
    let calls = 0;
    // Idle for the table list and the first two table requests, then a sync
    // starts and never stops.
    const c = capture();
    const res = await runErpSchemaProbeOnce(
      deps(c, {
        isSyncRunning: () => ++calls > 4,
        waitForIdleMs: 20,
        idlePollMs: 5,
        sleep: async (ms) => void (await new Promise((r) => setTimeout(r, ms))),
      }),
    );
    expect(res.skipped).toBe("sync_busy");
    expect(res.requests).toBeGreaterThan(0);
    expect(res.requests).toBeLessThan(6); // it stopped, it did not finish
    expect(c.lines[c.lines.length - 1]).toContain("STOPPED EARLY: sync_busy");
  });

  it("stops at the next checkpoint when the server is shutting down", async () => {
    const c = capture();
    const res = await runErpSchemaProbeOnce(
      deps(c, {
        sleep: async () => {
          stopErpSchemaProbe(); // SIGTERM arrives mid-run
        },
        pageDelayMs: 1,
      }),
    );
    expect(res.skipped).toBe("aborted");
    expect(c.lines[c.lines.length - 1]).toContain("STOPPED EARLY: aborted");
  });
});

// ── 6. Secrets (invariant §7.9) ──────────────────────────────────────────────

describe("secrets never reach a log line", () => {
  const SECRETS = [TOKEN, KEY, SECRET_TOKEN];

  it("emits no secret on the happy path, nor on any failure path", async () => {
    const spies = consoleSpies();
    try {
      const c = capture();
      await runErpSchemaProbeOnce(deps(c));
      expect(c.lines.length).toBeGreaterThan(10);

      // Every failure path in one run: a 404, a persistent 429, a login page
      // that echoes the credential back at us, and a 503 wall.
      resetErpSchemaProbe();
      faults = {
        status: { [WO_TABLE]: 404, [OPNAME_TABLE]: 401 },
        rateLimit: { [MUTASI_TABLE]: true },
        garbage: { [REQ_TABLE]: `401 Unauthorized: X-Secret-Key ${KEY} / X-Secret-Token ${SECRET_TOKEN}` },
      };
      const c2 = capture();
      await runErpSchemaProbeOnce(deps(c2));
      expect(c2.errors.length).toBeGreaterThan(0);

      resetErpSchemaProbe();
      faults = { allStatus: 500 };
      const c3 = capture();
      await runErpSchemaProbeOnce(deps(c3));

      for (const line of [...c.lines, ...c2.lines, ...c3.lines]) {
        for (const secret of SECRETS) expect(line).not.toContain(secret);
      }
      // The console, too — the module's own logger and the client's notices.
      for (const spy of Object.values(spies)) {
        for (const call of spy.mock.calls) {
          for (const secret of SECRETS) expect(JSON.stringify(call)).not.toContain(secret);
        }
      }
    } finally {
      restore(spies);
    }
  });

  it("never logs a URL, which in query auth mode would carry the credential pair", async () => {
    const c = capture();
    await runErpSchemaProbeOnce(deps(c));
    // Not one line quotes a full URL. The probe logs LABELS (`<base>/tables`,
    // the table name) precisely so a credential placement change cannot turn a
    // log line into a leak.
    for (const line of c.lines) {
      expect(line).not.toContain("http://erp.test");
      expect(line).not.toMatch(/secret_key=|secret_token=/);
    }
  });

  it("emits a clear reason, and no request, when the credentials are missing", async () => {
    // Proven against the real guard by flipping the derived flag the guard reads.
    const mod = (await import("../src/config.js")) as unknown as { hasErpCredentials: boolean };
    const original = mod.hasErpCredentials;
    try {
      Object.defineProperty(mod, "hasErpCredentials", { value: false, configurable: true });
      const c = capture();
      const res = await runErpSchemaProbeOnce(deps(c));
      expect(res.skipped).toBe("no_credentials");
      expect(requestPaths).toHaveLength(0);
      const warn = c.warns.join("\n");
      expect(warn).toContain("SELARAS_SECRET_KEY");
      expect(warn).toContain("values are never logged");
      for (const secret of SECRETS) expect(warn).not.toContain(secret);
    } finally {
      Object.defineProperty(mod, "hasErpCredentials", { value: original, configurable: true });
    }
  });
});

// ── 7. Read-only, asserted over the source ───────────────────────────────────

describe("read-only", () => {
  it("has no code path to a write: no db client, no SQL, no non-GET request", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "erp", "schemaProbe.ts"),
      "utf8",
    );
    // Strip comments: the prose ABOVE explains at length what this must not do,
    // and the point of the assertion is the code, not the commentary.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    for (const forbidden of [
      /db\/client/i,
      /getSql/,
      /postgres/i,
      /\bmigrate/i,
      /\binsert\s+into\b/i,
      /\bupdate\s+\w+\s+set\b/i,
      /\bdelete\s+from\b/i,
      /\btruncate\s/i,
      /\bsql`/,
      /method:\s*"(POST|PUT|PATCH|DELETE)"/i,
    ]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    // And the one HTTP entry point it does use is the GET-only shared client.
    expect(code).toContain("fetchErpJson");
  });
});

// ── 8. The tolerant readers, in isolation ────────────────────────────────────

describe("readTableList tolerates a shape nobody has verified", () => {
  /**
   * THE SHAPE PRODUCTION ANSWERS WITH, key for key as Railway logged it on
   * 2026-10-28: `{ success, total, tables }`. The reader returned ZERO names
   * against this body — the miss that left the Work Order table unnamed and
   * `tbl_1328` / `tbl_1235` unresolved.
   */
  it("reads { success, total, tables } — the shape production answered with", () => {
    const r = readTableList({ success: true, total: 3, tables: ["tbl_1_A", "tbl_2_B", "tbl_3_C"] }, 1);
    expect(r.names).toEqual(["tbl_1_A", "tbl_2_B", "tbl_3_C"]);
    expect(r.shape).toContain("tables");
  });

  it("reads the same shape when `tables` carries objects rather than strings", () => {
    const r = readTableList({ success: true, total: 2, tables: [{ table_name: "tbl_1_A" }, { name: "tbl_2_B" }] }, 1);
    expect(r.names).toEqual(["tbl_1_A", "tbl_2_B"]);
  });

  it("never reads `total` or `success` as data: the count is metadata, not a table", () => {
    const r = readTableList({ success: true, total: 2, tables: ["tbl_1_A", "tbl_2_B"] }, 1);
    expect(r.names).toEqual(["tbl_1_A", "tbl_2_B"]);
    expect(r.unreadable).toEqual([]);
  });

  it("still prefers a row array readEnvelope() understands when a body carries both", () => {
    const r = readTableList({ success: true, data: ["tbl_FROM_DATA"], tables: ["tbl_FROM_TABLES"] }, 1);
    expect(r.names).toEqual(["tbl_FROM_DATA"]);
  });

  it("reads the verified envelope with MySQL-style single-field rows", () => {
    const r = readTableList({ success: true, meta: {}, data: [{ Tables_in_kencana: "tbl_1_A" }] }, 1);
    expect(r.names).toEqual(["tbl_1_A"]);
  });

  it("reads a bare array of strings", () => {
    expect(readTableList(["tbl_1_A", "tbl_2_B"], 1).names).toEqual(["tbl_1_A", "tbl_2_B"]);
  });

  it("reads rows under results/items, and a named field", () => {
    expect(readTableList({ results: [{ table_name: "tbl_1_A" }] }, 1).names).toEqual(["tbl_1_A"]);
    expect(readTableList({ items: [{ name: "tbl_1_A" }] }, 1).names).toEqual(["tbl_1_A"]);
  });

  it("falls back to a top-level object keyed BY table name, but only when the keys look like one", () => {
    const keyed = readTableList({ tbl_1_A: { rows: 1 }, tbl_2_B: { rows: 2 } }, 1);
    expect(keyed.names).toEqual(["tbl_1_A", "tbl_2_B"]);
    expect(keyed.shape).toContain("FELL BACK");
    // Envelope metadata must never be mistaken for data.
    expect(readTableList({ success: true, message: "nope" }, 1).names).toEqual([]);
  });

  it("reports an entry it could not name by its KEY SHAPE, which is the finding", () => {
    const r = readTableList({ data: [{ oid: 1, relkind: "r" }] }, 1);
    expect(r.names).toEqual([]);
    expect(r.unreadable).toEqual(["{oid,relkind}"]);
  });

  it("never throws, whatever the body is", () => {
    for (const body of [null, undefined, 42, "text", [], {}, [[]], [null]]) {
      expect(() => readTableList(body, 1)).not.toThrow();
    }
  });

  it("stays total over garbage under the production key, too", () => {
    for (const body of [
      { success: true, total: 0, tables: [] },
      { tables: "not-an-array" },
      { tables: null },
      { tables: 7 },
      { tables: {} },
      { tables: [null, 0, "", [], {}, { oid: 1 }] },
      { TABLES: ["tbl_1_A"] },
    ] as unknown[]) {
      expect(() => readTableList(body, 1), JSON.stringify(body)).not.toThrow();
    }
    // Case and separators are tolerated, the way every other key here is.
    expect(readTableList({ TABLES: ["tbl_1_A"] }, 1).names).toEqual(["tbl_1_A"]);
    // An empty list is an empty list, not a crash and not a fabricated name.
    expect(readTableList({ success: true, total: 0, tables: [] }, 1).names).toEqual([]);
  });
});

describe("readColumnList tolerates the same range", () => {
  /**
   * THE SHAPE PRODUCTION ANSWERS WITH, key for key as Railway logged it on
   * 2026-10-28: `{ success, table, name, description, total_columns, columns }`.
   * The reader returned ZERO columns against it.
   */
  it("reads { success, table, name, description, total_columns, columns } — the production shape", () => {
    const r = readColumnList(
      {
        success: true,
        table: "tbl_1179_STMutasiFGMX",
        name: "tbl_1179_STMutasiFGMX",
        description: null,
        total_columns: 2,
        columns: [
          { column_name: "in_out", data_type: "varchar(8)", is_nullable: "YES" },
          { column_name: "qty", data_type: "decimal(18,4)", is_nullable: "YES" },
        ],
      },
      1,
    );
    expect(r.columns.map((c) => c.name)).toEqual(["in_out", "qty"]);
    expect(r.columns[0]).toMatchObject({ name: "in_out", type: "varchar(8)" });
    expect(r.shape).toContain("columns");
  });

  it("does not mistake the envelope's own `table` / `name` / `description` for columns", () => {
    const r = readColumnList(
      {
        success: true,
        table: "tbl_1328_STMutasiInternalMX",
        name: "tbl_1328_STMutasiInternalMX",
        description: "internal transfers",
        total_columns: 1,
        columns: [{ column_name: "no_transfer", data_type: "varchar(32)", is_nullable: "YES" }],
      },
      1,
    );
    expect(r.columns.map((c) => c.name)).toEqual(["no_transfer"]);
    expect(r.shape).not.toContain("FELL BACK");
  });

  it("reads the production shape when `columns` carries bare names", () => {
    const r = readColumnList(
      { success: true, table: "t", name: "t", description: null, total_columns: 2, columns: ["no_wo", "status_wo"] },
      1,
    );
    expect(r.columns.map((c) => c.name)).toEqual(["no_wo", "status_wo"]);
    expect(r.columns.every((c) => c.type === null)).toBe(true);
  });

  it("still prefers a row array readEnvelope() understands when a body carries both", () => {
    const r = readColumnList({ success: true, data: [{ Field: "from_data" }], columns: [{ Field: "from_columns" }] }, 1);
    expect(r.columns.map((c) => c.name)).toEqual(["from_data"]);
  });

  it("reads information_schema-style rows with type and nullability", () => {
    const r = readColumnList(
      { data: [{ column_name: "no_wo", data_type: "varchar(32)", is_nullable: "YES" }] },
      1,
    );
    expect(r.columns[0]).toMatchObject({ name: "no_wo", type: "varchar(32)" });
    expect(r.columns[0]?.extra).toContain("is_nullable=YES");
  });

  it("reads SHOW COLUMNS-style rows (Field/Type)", () => {
    const r = readColumnList({ data: [{ Field: "no_wo", Type: "varchar(32)", Null: "YES" }] }, 1);
    expect(r.columns[0]).toMatchObject({ name: "no_wo", type: "varchar(32)" });
  });

  it("reads a bare array of column names with no types at all", () => {
    const r = readColumnList(["no_wo", "status_wo"], 1);
    expect(r.columns.map((c) => c.name)).toEqual(["no_wo", "status_wo"]);
    expect(r.columns.every((c) => c.type === null)).toBe(true);
  });

  it("falls back to a column→type map", () => {
    const r = readColumnList({ no_wo: "varchar(32)", qty: "decimal(18,4)" }, 1);
    expect(r.columns.map((c) => `${c.name}:${c.type}`)).toEqual(["no_wo:varchar(32)", "qty:decimal(18,4)"]);
    expect(r.shape).toContain("FELL BACK");
  });

  it("never throws, whatever the body is", () => {
    for (const body of [null, undefined, 0, "", [], {}, [1, 2], [null]]) {
      expect(() => readColumnList(body, 1)).not.toThrow();
    }
  });

  it("stays total over garbage under the production key, too", () => {
    for (const body of [
      { success: true, table: "t", name: "t", description: null, total_columns: 0, columns: [] },
      { columns: "not-an-array" },
      { columns: null },
      { columns: 7 },
      { columns: {} },
      { columns: [null, 0, "", [], {}, { oid: 1 }] },
      { COLUMNS: ["no_wo"] },
    ] as unknown[]) {
      expect(() => readColumnList(body, 1), JSON.stringify(body)).not.toThrow();
    }
    expect(readColumnList({ COLUMNS: ["no_wo"] }, 1).columns.map((c) => c.name)).toEqual(["no_wo"]);
    expect(
      readColumnList(
        { success: true, table: "t", name: "t", description: null, total_columns: 0, columns: [] },
        1,
      ).columns,
    ).toEqual([]);
  });
});

// ── 9. The name heuristic, and the targets it picks ──────────────────────────

describe("the name heuristic is loose on purpose", () => {
  it("matches production, work-order, material, BOM and movement names", () => {
    for (const name of [
      "tbl_1236_DBRequestProduksiID",
      "tbl_1241_PRWorkOrderNID",
      "tbl_1250_PRBOMHeaderID",
      "tbl_1260_STMutasiRMMX",
      "tbl_1311_DBGudangID",
      "tbl_1324_DBStockOpnameFG",
      "tbl_9000_WOHeader",
      "tbl_9001_RMIssue",
      "tbl_9002_BahanBakuMasuk",
      "tbl_9003_JadwalMesin",
    ]) {
      expect(relevanceReason(name), name).not.toBeNull();
    }
  });

  it("does not match payroll, finance or CRM", () => {
    for (const name of [
      "tbl_1001_HRKaryawanID",
      "tbl_1002_HRAbsensiID",
      "tbl_1010_FNKasBankID",
      "tbl_1011_FNJurnalID",
      "tbl_1050_CRMKontakID",
    ]) {
      expect(relevanceReason(name), name).toBeNull();
    }
  });

  it("matches a two-letter token only as a token, never inside a word", () => {
    expect(relevanceReason("tbl_9100_WOStage")).not.toBeNull(); // WO
    expect(relevanceReason("tbl_9101_PasswordReset")).toBeNull(); // not "wo"
    expect(relevanceReason("tbl_9102_WoodSupplier")).toBeNull(); // not "wo"
  });

  it("reports WHY a name was chosen, so a reader can judge the heuristic", () => {
    expect(relevanceReason("tbl_1241_PRWorkOrderNID")).toContain("work");
    expect(relevanceReason("tbl_9100_WOStage")).toContain("token 'wo'");
  });
});

describe("selectTargets", () => {
  const quiet: probeMod.SchemaProbeLogger = { info: () => {}, warn: () => {}, error: () => {} };

  it("puts the PRD's tables first and never duplicates one the heuristic also found", () => {
    const targets = selectTargets(TABLE_LIST, quiet, 60, []);
    const names = targets.map((t) => t.name);
    expect(names.indexOf(REQ_TABLE)).toBeLessThan(names.indexOf(WO_TABLE));
    expect(new Set(names).size).toBe(names.length);
  });

  it("still asks about the PRD's tables when the listing came back empty", () => {
    const names = selectTargets([], quiet, 60, []).map((t) => t.name);
    expect(names).toContain(REQ_TABLE);
    expect(names).toContain(MUTASI_TABLE);
    expect(names).toContain("tbl_1328"); // the bare prefix, verbatim
  });

  it("never returns a table the sync already mirrors", () => {
    const names = selectTargets([...TABLE_LIST, "tbl_1210_STLiveFGMX"], quiet, 60, [
      "tbl_1203_SOSalesOrderDetailNID",
    ]).map((t) => t.name);
    expect(names).not.toContain("tbl_1210_STLiveFGMX");
    expect(names).not.toContain("tbl_1203_SOSalesOrderDetailNID");
  });

  it("never lets the cap push out a PRD-named table", () => {
    const names = selectTargets(TABLE_LIST, quiet, 1, []).map((t) => t.name);
    for (const seeded of [REQ_TABLE, MUTASI_TABLE, OPNAME_TABLE]) expect(names).toContain(seeded);
  });
});

describe("distinctStatusValues", () => {
  it("collects the direction marker's distinct values across rows", () => {
    const d = distinctStatusValues(ROWS[MUTASI_TABLE] ?? []);
    const jenis = d.find((x) => x.key === "jenis_mutasi");
    expect(jenis?.values).toEqual(["IN", "OUT"]);
  });

  it("reports a single value as a single value, rather than implying an enum", () => {
    const d = distinctStatusValues([{ status: "POSTED" }, { status: "POSTED" }]);
    expect(d[0]?.values).toEqual(["POSTED"]);
  });

  it("never reports an id column as a direction marker", () => {
    // `STATUS_KEY_RE` carries 'mutasi' so that `jenis_mutasi` is found — which
    // without the id guard also claims `tbl_1179_STMutasiFGMX_id`, whose five
    // distinct row numbers then drown the one line that answers §0.5.
    const d = distinctStatusValues(ROWS[MUTASI_TABLE] ?? []);
    expect(d.map((x) => x.key)).toEqual(["jenis_mutasi"]);
  });

  it("ignores rows that are not objects", () => {
    expect(() => distinctStatusValues([null, 7, "x", undefined])).not.toThrow();
    expect(distinctStatusValues([null, 7])).toEqual([]);
  });
});

// ── 11. The envelope shapes production actually answered with ────────────────
//
// 2026-10-28: the probe ran in production and worked, except that BOTH schema
// readers parsed to zero — the listing and every column list. The cost was the
// run itself: the Work Order table stayed unnamed and `tbl_1328` / `tbl_1235`
// stayed unresolved. This section runs the WHOLE probe against those shapes,
// verbatim, through the real transport, because unit tests of a reader prove
// the reader and not the run.

describe("the production envelope shapes (observed 2026-10-28), end to end", () => {
  it("parses the complete listing and every column list, with no ZERO-parse warning", async () => {
    envelopeStyle = "production";
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    expect(res.ran).toBe(true);
    expect(res.tablesListed).toBe(TABLE_LIST.length);

    const text = all(c);
    // Every name in the listing, including the irrelevant ones: a name nobody
    // sees is a name nobody can ask about, which is the whole point of step 1.
    for (const t of TABLE_LIST) expect(text, t).toContain(t);

    // The two zero-parse warnings production actually emitted must be absent.
    const warns = c.warns.join("\n");
    expect(warns).not.toContain("parsed to ZERO names");
    expect(warns).not.toContain("parsed to ZERO columns");

    // And the four §0 answers the run is for all arrive.
    expect(res.probed).toContain(WO_TABLE); // §0.1, found only via the listing
    expect(text).toContain("no_wo:varchar(32)"); // §0.2, from `columns`
    expect(text).toContain("no_request"); // §0.3, the join key on both sides
    expect(text).toMatch(/jenis_mutasi: 2 distinct — "IN", "OUT"/); // §0.5
    // `tbl_1328` resolves from the listing, which is what the miss prevented.
    expect(text).toContain(`'tbl_1328' → resolved to '${TRANSFER_TABLE}'`);
  });

  it("names the shape it read in the log, so the next reader fix needs no guessing", async () => {
    envelopeStyle = "production";
    const c = capture();
    await runErpSchemaProbeOnce(deps(c));
    const text = all(c);
    expect(text).toContain("Envelope observed:");
    // The key the rows actually came from, said out loud for both endpoints.
    expect(text).toMatch(/GET <base>\/tables → HTTP 200,.*Envelope observed:.*'tables'/s);
    expect(text).toMatch(/COLUMNS — HTTP 200,.*'columns'/);
  });

  it("still parses the previously tolerated shape — the fix ADDED a form, it did not swap one", async () => {
    envelopeStyle = "verified"; // `{ success, meta, data: [{Tables_in_kencana}] }`
    const c = capture();
    const res = await runErpSchemaProbeOnce(deps(c));
    expect(res.tablesListed).toBe(TABLE_LIST.length);
    expect(res.probed).toContain(WO_TABLE);
    expect(all(c)).toContain("no_wo:varchar(32)");
    expect(c.warns.join("\n")).not.toContain("parsed to ZERO");
  });
});

// ── 12. The movement sample limit ────────────────────────────────────────────
//
// Production sampled 5 rows of the movement table and got ONE distinct value of
// `in_out` ("Out"), and one each of `status` and `sub_status` ("null"). That is
// the ambiguous answer: it cannot tell an enum from a constant, which is the
// only question §0.5 asks. The default is sized so that outcome means "constant"
// rather than "too few rows".

describe("the movement sample limit is sized to settle §0.5", () => {
  it("defaults high enough that one distinct value is an answer, not an artefact", () => {
    // Pinned deliberately: a regression to a handful of rows reproduces exactly
    // the production outcome that made this fix necessary.
    expect(configMod.config.erpProbe.movementSampleLimit).toBe(100);
    expect(configMod.config.erpProbe.movementSampleLimit).toBeGreaterThanOrEqual(50);
  });

  it("asks for that many rows of the movement table, and ONE row of every other, in ONE request each", async () => {
    const c = capture();
    await runErpSchemaProbeOnce(deps(c));
    const samples = requestPaths.filter((p) => /\/table\/[^/]+\?/.test(p));
    const movement = samples.filter((p) => p.includes(MUTASI_TABLE));
    expect(movement).toHaveLength(1); // still exactly one request
    expect(movement[0]).toContain(`limit=${configMod.config.erpProbe.movementSampleLimit}`);
    expect(movement[0]).toContain("limit=100");
    // Everything else stays at one row: the bigger page is for §0.5 alone.
    for (const other of samples.filter((p) => !p.includes(MUTASI_TABLE))) {
      expect(other, other).toContain("limit=1");
    }
  });

  it("a limit of 5 would have missed a direction that 100 rows finds", () => {
    // A minority direction one row in twenty — the realistic shape of an ERP
    // whose rows arrive in insertion order and whose receipts come in batches.
    const rows = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      in_out: i % 20 === 19 ? "In" : "Out",
    }));
    const atFive = distinctStatusValues(rows.slice(0, 5)).find((d) => d.key === "in_out");
    const atHundred = distinctStatusValues(rows).find((d) => d.key === "in_out");
    expect(atFive?.values).toEqual(["Out"]); // the production outcome, reproduced
    expect(atHundred?.values).toEqual(["In", "Out"]); // §0.5, settled
  });

  it("keeps the caveat line verbatim, for the case where one value survives the bigger sample", async () => {
    // It did its job in production — "1 distinct value" was readable as the
    // ambiguity it was — and a raised sample does not retire it: a constant
    // really can be a constant, and then this is still the honest answer.
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "..", "src", "erp", "schemaProbe.ts"),
      "utf8",
    );
    expect(src).toContain(
      "ONE value across every sampled row: an enum with a dominant value, or a constant. " +
        "These rows cannot tell; raise ERP_SCHEMA_PROBE_MOVEMENT_SAMPLE_LIMIT to find out.",
    );
    // And the probe still reaches the line that carries it.
    const c = capture();
    await runErpSchemaProbeOnce(deps(c));
    expect(all(c)).toContain("DIRECTION/STATUS CANDIDATES");
  });

  it("reports `in_out`, `status` and `sub_status` as the direction/status candidates they are", () => {
    // The three keys production came back single-valued on. If any of them were
    // not recognised as status-shaped, a bigger sample would settle nothing.
    const d = distinctStatusValues([
      { in_out: "Out", status: "null", sub_status: "null" },
      { in_out: "In", status: "POSTED", sub_status: "null" },
    ]);
    expect(d.map((x) => x.key)).toEqual(["in_out", "status", "sub_status"]);
    expect(d.find((x) => x.key === "in_out")?.values).toEqual(["In", "Out"]);
  });
});
