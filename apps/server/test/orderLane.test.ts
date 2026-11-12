/**
 * Kabar Pesanan WP-2: the order lane (1202/1236/1082/1205/1130), the extended
 * SO header, fetchRawPage, and the Selaras webhook receiver.
 *
 * No network: the HTTP layer is undici's MockAgent; the lane tests inject a
 * fake page fetcher. DB blocks skip without DATABASE_URL.
 */
import Fastify from "fastify";
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher, type Dispatcher } from "undici";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// config.ts freezes env at import time: set it before any module under test loads.
process.env["SELARAS_BASE_URL"] = "http://erp-orders.test/kencana/api";
process.env["SELARAS_SECRET_KEY"] = "kkkkkkkk";
process.env["SELARAS_SECRET_TOKEN"] = "tttttttt";
process.env["SELARAS_AUTH_MODE"] = "header";
process.env["ERP_WEBHOOK_SECRET"] = "whsec_test_123456";
process.env["STOCK_SYNC_RATE_LIMIT_ATTEMPTS"] = "1";

const client = await import("../src/erp/selarasClient.js");
const tables = await import("../src/erp/orderTables.js");
const lane = await import("../src/erp/orderSync.js");
const hook = await import("../src/routes/erp-webhook.js");
const dbmod = await import("../src/db/client.js");
const { runErpStockMigrations } = await import("../src/db/migrateErpStock.js");
const { runOrderMigrations } = await import("../src/db/migrateOrders.js");
const { runEventMigrations } = await import("../src/db/migrateEvents.js");

const P = "wp2lane";

// ── Pure: adapters ───────────────────────────────────────────────────────────

describe("order adapters (verified field meanings)", () => {
  it("1082 DO header: labels for combos, sj_date as the scheduled date", () => {
    const r = tables.adaptDoHeaderRow({
      tbl_1082_SOLogisticPID_id: 77930,
      so_no: "SO.26/12821",
      no_sj: "KP/DO-13224/11/26",
      sj_date: "2026-11-11",
      do_created_at: "2026-11-10 15:02:11",
      cara_kirim: 7,
      cara_kirim_label: "di Ambil",
      cancel_order: "No",
      top_days: "30",
      due_date: "2026-12-11",
      invoice_no: "KP/INV/2026-11-0001",
      customer_name: 4411,
      customer_name_label: "FITRAH JAYA",
      updated_at: "2026-11-10 15:02:11",
      created_at: "2026-11-10 15:02:11",
    });
    expect(r).toMatchObject({
      id: "77930",
      so_no: "SO.26/12821",
      no_sj: "KP/DO-13224/11/26",
      sj_date: "2026-11-11",
      cara_kirim: "di Ambil",
      cancel_order: "No",
      top_days: 30,
      due_date: "2026-12-11",
      customer_name_id: "4411",
      customer_name_text: "FITRAH JAYA",
      deleted_at: null,
    });
    expect(r!.erp_updated_at!.toISOString()).toBe("2026-11-10T15:02:11.000Z");
  });

  it("1205 DO line: Selaras `sj_no` is the 1082 row id, mirrored as sj_id", () => {
    const r = tables.adaptDoLineRow({
      tbl_1205_SOSalesOrderDeliveryNID_id: "143030",
      po_no: "SO.26/12821",
      so_item_no: "142001",
      sj_no: "77930",
      qty_delivered: "5.00",
    });
    expect(r).toMatchObject({ id: "143030", po_no: "SO.26/12821", so_item_no: "142001", sj_id: "77930", qty_delivered: 5 });
  });

  it("1236 request: th_alu_skin is PANEL (th_panel), alu is skin (th_skin)", () => {
    const r = tables.adaptRequestProduksiRow({
      tbl_1236_DBRequestProduksiID_id: 9065,
      so_ms: "SO",
      so_no: "SO.26/12821",
      wo_no: "WO.26/00041",
      sticker: 3,
      sticker_label: "ALCOPAN",
      th_alu_skin: "4",
      alu: "0.21",
      qty_lembar: "100",
    });
    expect(r).toMatchObject({ id: "9065", so_ms: "SO", brand: "3", brand_text: "ALCOPAN", th_panel: 4, th_skin: 0.21, qty_lembar: 100 });
  });

  it("1130 sales: no phone today, picked up automatically if Selaras adds one", () => {
    expect(tables.adaptSalesRow({ tbl_1130_CRMListSalesID_id: 12, sales_name: "Free Antony", active: "Yes" }))
      .toMatchObject({ id: "12", sales_name: "Free Antony", active: "Yes", phone: null });
    expect(tables.adaptSalesRow({ tbl_1130_CRMListSalesID_id: 12, no_hp: "0812-1111-2222" })!.phone).toBe("0812-1111-2222");
  });

  it("rows without a primary key are dropped, never thrown on", () => {
    expect(tables.adaptDoHeaderRow({ so_no: "x" })).toBeNull();
    expect(tables.adaptSalesRow("not a row")).toBeNull();
  });

  it("1202 header carries recipient, terms and the rep id (WP-2)", () => {
    const r = client.adaptSoHeaderRow({
      tbl_1202_SOSalesOrderNID_id: 75001,
      po_no: "SO.26/12821",
      customer_name: 4411,
      customer_name_label: "FITRAH JAYA",
      customer_final: 4411,
      buyer_name: 901,
      sales_name: 55,
      sales_name_label: "Free Antony",
      penerima: "Bp. Panji",
      kontak_penerima: "0812-8311-4455 / 0813-0000-1111",
      alamat_kirim: "Jl. Contoh 1",
      top_limit: "Cash before Delivery",
      top_limit_value: "0",
      approval_new: "Waiting",
      created_at: "2026-11-10 09:00:00",
    });
    expect(r).toMatchObject({
      po_no: "SO.26/12821",
      customer_name_text: "FITRAH JAYA",
      customer_name_id: "4411",
      customer_final_id: "4411",
      buyer_name_id: "901",
      sales_name_id: "55",
      sales_name_text: "Free Antony",
      penerima: "Bp. Panji",
      kontak_penerima: "0812-8311-4455 / 0813-0000-1111",
      top_limit: "Cash before Delivery",
      top_limit_value: 0,
      approval_new: "Waiting",
    });
    expect(r!.erp_created_at!.toISOString()).toBe("2026-11-10T09:00:00.000Z");
  });
});

// ── Pure: webhook helpers ────────────────────────────────────────────────────

describe("webhook signature and table resolution", () => {
  it("accepts the hex HMAC of the raw body, with or without a sha256= prefix", () => {
    const body = '{"table":"tbl_1082_SOLogisticPID","id":"1","action":"insert"}';
    const sig = hook.signWebhook("s3cret", body);
    expect(hook.verifyWebhookSignature("s3cret", body, sig)).toBe(true);
    expect(hook.verifyWebhookSignature("s3cret", body, `sha256=${sig}`)).toBe(true);
    expect(hook.verifyWebhookSignature("s3cret", body + " ", sig)).toBe(false);
    expect(hook.verifyWebhookSignature("other", body, sig)).toBe(false);
    expect(hook.verifyWebhookSignature("s3cret", body, "zz")).toBe(false);
    expect(hook.verifyWebhookSignature("", body, sig)).toBe(false);
  });
  it("resolves logical and ERP table names", () => {
    expect(hook.resolveLaneTable("do_header")).toBe("do_header");
    expect(hook.resolveLaneTable("tbl_1236_DBRequestProduksiID")).toBe("request_produksi");
    expect(hook.resolveLaneTable("TBL_1202_SOSALESORDERNID")).toBe("so_header");
    expect(hook.resolveLaneTable("tbl_1210_STLiveFGMX")).toBeNull();
    expect(hook.resolveLaneTable(42)).toBeNull();
  });
});

// ── fetchRawPage over MockAgent ──────────────────────────────────────────────

describe("fetchRawPage", () => {
  let agent: MockAgent;
  let seen: { path: string; headers: Record<string, string> }[] = [];
  beforeAll(() => {
    agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("http://erp-orders.test")
      .intercept({ path: (p: string) => p.startsWith("/kencana/api/table/"), method: "GET" })
      .reply((opts) => {
        const headers: Record<string, string> = {};
        for (const [k, v] of Object.entries((opts.headers ?? {}) as Record<string, unknown>)) headers[k.toLowerCase()] = String(v);
        seen.push({ path: String(opts.path), headers });
        if (String(opts.path).includes("fail")) {
          return { statusCode: 200, data: JSON.stringify({ success: false, message: "nope" }) };
        }
        return {
          statusCode: 200,
          data: JSON.stringify({ success: true, meta: { total_pages: 1, total: 1 }, data: [{ tbl_1082_SOLogisticPID_id: 1 }, "junk"] }),
        };
      })
      .persist();
  });
  beforeEach(() => {
    seen = [];
  });

  it("builds <base>/table/<erp table>?filters&limit&page with header auth", async () => {
    const r = await client.fetchRawPage("do_header", {
      params: { updated_at__gte: "2026-11-10 00:00:00", order_by: "updated_at", order_dir: "asc" },
      page: 2,
      limit: 500,
      dispatcher: agent as unknown as Dispatcher,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.rows).toEqual([{ tbl_1082_SOLogisticPID_id: 1 }]); // non-objects dropped
    const u = new URL(`http://x${seen[0]!.path}`);
    expect(u.pathname).toBe("/kencana/api/table/tbl_1082_SOLogisticPID");
    expect(u.searchParams.get("updated_at__gte")).toBe("2026-11-10 00:00:00");
    expect(u.searchParams.get("limit")).toBe("500");
    expect(u.searchParams.get("page")).toBe("2");
    expect(seen[0]!.headers["x-secret-key"]).toBe("kkkkkkkk");
  });

  it("success:false is a failed page, not an empty one", async () => {
    const r = await client.fetchRawPage("sales", { params: { q: "fail" }, page: 1, limit: 5, dispatcher: agent as unknown as Dispatcher });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("erp_error");
  });

  it("formatMirroredDatetime returns the stored wall-clock digits, no zone shift", () => {
    expect(client.formatMirroredDatetime(new Date("2026-11-10T15:02:11Z"))).toBe("2026-11-10 15:02:11");
  });
});

// ── The lane over a real database ────────────────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);
const NOW = new Date("2026-11-10T08:00:00Z");

type Raw = Record<string, unknown>;
type FakeErp = Partial<Record<string, Raw[]>>;

/** A page fetcher over in-memory tables that honours `<field>__gte`, order and paging. */
function fakeFetcher(erp: FakeErp, calls: { table: string; params: Record<string, string>; page: number }[], failTables: string[] = []) {
  return async (table: string, o: { params: Record<string, string>; page: number; limit: number }) => {
    calls.push({ table, params: o.params, page: o.page });
    if (failTables.includes(table)) {
      return { ok: false as const, error: "HTTP 500 from ERP", status: 500, kind: "server" as const, retryable: true };
    }
    let rows = [...(erp[table] ?? [])];
    for (const [k, v] of Object.entries(o.params)) {
      if (k.endsWith("__gte")) {
        const f = k.slice(0, -5);
        rows = rows.filter((r) => typeof r[f] === "string" && (r[f] as string) >= v);
      } else if (k !== "order_by" && k !== "order_dir") {
        rows = rows.filter((r) => String(r[k]) === v);
      }
    }
    const by = o.params["order_by"];
    if (by) rows.sort((a, b) => String(a[by]).localeCompare(String(b[by])));
    const start = (o.page - 1) * o.limit;
    return {
      ok: true as const,
      rows: rows.slice(start, start + o.limit),
      totalPages: Math.max(1, Math.ceil(rows.length / o.limit)),
      rateLimited: false,
    };
  };
}

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

function seedErp(): FakeErp {
  return {
    so_header: [
      { tbl_1202_SOSalesOrderNID_id: `${P}-h1`, po_no: `${P}/SO-1`, penerima: "Bp. Panji", kontak_penerima: "0812-8311-4455", sales_name: 55, updated_at: "2026-11-10 09:00:00", created_at: "2026-11-10 09:00:00" },
      { tbl_1202_SOSalesOrderNID_id: `${P}-h-del`, po_no: `${P}/SO-X`, deleted_at: "2026-11-10 09:05:00", updated_at: "2026-11-10 09:05:00" },
    ],
    request_produksi: [
      { tbl_1236_DBRequestProduksiID_id: `${P}-r1`, so_ms: "SO", so_no: `${P}/SO-1`, wo_no: "WO.26/1", updated_at: "2026-11-10 09:10:00", created_at: "2026-11-10 09:10:00" },
      // updated_at blank: only the created_at cursor can see it.
      { tbl_1236_DBRequestProduksiID_id: `${P}-r2`, so_ms: "SO", so_no: `${P}/SO-1`, wo_no: "WO.26/2", created_at: "2026-11-10 09:11:00" },
    ],
    do_header: [
      { tbl_1082_SOLogisticPID_id: `${P}-d1`, so_no: `${P}/SO-1`, no_sj: "KP/DO-1", sj_date: "2026-11-11", cara_kirim_label: "di Antar", cancel_order: "No", updated_at: "2026-11-10 10:00:00", created_at: "2026-11-10 10:00:00" },
      { tbl_1082_SOLogisticPID_id: `${P}-d2`, so_no: `${P}/SO-1`, no_sj: "KP/DO-2", sj_date: "2026-11-12", cancel_order: "No", updated_at: "2026-11-10 10:01:00" },
      { tbl_1082_SOLogisticPID_id: `${P}-d3`, so_no: `${P}/SO-1`, no_sj: "KP/DO-3", sj_date: "2026-11-12", cancel_order: "Yes", deleted_at: "2026-11-10 10:03:00", updated_at: "2026-11-10 10:02:00" },
    ],
    do_line: [
      { tbl_1205_SOSalesOrderDeliveryNID_id: `${P}-dl1`, po_no: `${P}/SO-1`, sj_no: `${P}-d1`, qty_delivered: "5", updated_at: "2026-11-10 10:00:00" },
    ],
    sales: [{ tbl_1130_CRMListSalesID_id: `${P}-s55`, sales_name: "Free Antony", active: "Yes", updated_at: "2026-11-01 00:00:00" }],
  };
}

describe.skipIf(!hasDb)("order lane over the real schema", () => {
  let db: NonNullable<ReturnType<typeof dbmod.getSql>>;
  let previousDispatcher: Dispatcher;
  let agent: MockAgent;
  let webhookRow: Raw | null = null;

  async function cleanup(): Promise<void> {
    await db`delete from erp_so_header where id like ${`${P}%`}`;
    for (const t of ["erp_do_header", "erp_do_line", "erp_request_produksi", "erp_sales"]) {
      await db`delete from ${db(t)} where id like ${`${P}%`}`;
    }
    await db`delete from erp_order_sync_state`;
    // events.test.ts sweeps the whole mirror in parallel and may derive events
    // from this suite's rows; they are this suite's to remove.
    await db`delete from order_events where event_key like ${`%${P}%`} or so_no like ${`${P}%`}`;
    await db`update erp_order_sync_lease set owner = null, lease_until = null where id = 1`;
  }

  beforeAll(async () => {
    const s = dbmod.getSql();
    if (!s) throw new Error("DATABASE_URL is set but getSql() returned null");
    db = s;
    await runErpStockMigrations(db);
    await runOrderMigrations(db);
    await runEventMigrations(db);
    previousDispatcher = getGlobalDispatcher();
    agent = new MockAgent();
    agent.disableNetConnect();
    agent
      .get("http://erp-orders.test")
      .intercept({ path: (p: string) => p.startsWith("/kencana/api/table/"), method: "GET" })
      .reply(() => ({
        statusCode: 200,
        data: JSON.stringify({ success: true, meta: { total_pages: 1 }, data: webhookRow ? [webhookRow] : [] }),
      }))
      .persist();
    setGlobalDispatcher(agent);
  }, 60_000);
  beforeEach(async () => {
    lane.resetOrderLaneForTests();
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    setGlobalDispatcher(previousDispatcher);
    await dbmod.closeDatabase();
  });

  it("mirrors every fast table, keeps deleted DOs, removes deleted headers, and skips sales unless slow", async () => {
    const calls: { table: string; params: Record<string, string>; page: number }[] = [];
    const heard: string[][] = [];
    lane.onOrderRows(async (t) => {
      heard.push(t.do_header);
    });
    const r = await lane.runOrderSyncOnce({
      db, fetchPage: fakeFetcher(seedErp(), calls) as never, now: () => NOW, log: quiet,
      pageSize: 2, maxPagesPerTick: 10, backfillDays: 60, lookbackMinutes: 0,
    });
    expect(r.ran).toBe(true);
    expect(r.results.every((x) => x.error === null)).toBe(true);

    const [h] = await db`select po_no, penerima, kontak_penerima, sales_name_id from erp_so_header where id = ${`${P}-h1`}`;
    expect(h).toMatchObject({ po_no: `${P}/SO-1`, penerima: "Bp. Panji", kontak_penerima: "0812-8311-4455", sales_name_id: "55" });
    expect(await db`select 1 from erp_so_header where id = ${`${P}-h-del`}`).toHaveLength(0);

    const dos = await db<{ id: string; deleted: boolean }[]>`
      select id, deleted_at is not null as deleted from erp_do_header where id like ${`${P}%`} order by id`;
    expect(dos).toEqual([
      { id: `${P}-d1`, deleted: false },
      { id: `${P}-d2`, deleted: false },
      { id: `${P}-d3`, deleted: true },
    ]);
    // 3 DOs at page size 2 ⇒ two pages.
    expect(calls.filter((c) => c.table === "do_header").map((c) => c.page)).toEqual([1, 2]);

    // created_at safety: r2 has no updated_at, yet it is mirrored.
    const reqs = await db`select id from erp_request_produksi where id like ${`${P}%`} order by id`;
    expect(reqs.map((x) => x.id)).toEqual([`${P}-r1`, `${P}-r2`]);
    expect(calls.some((c) => c.table === "request_produksi" && "created_at__gte" in c.params)).toBe(true);

    expect(await db`select 1 from erp_sales where id like ${`${P}%`}`).toHaveLength(0);
    expect(calls.some((c) => c.table === "sales")).toBe(false);

    const [dl] = await db`select sj_id from erp_do_line where id = ${`${P}-dl1`}`;
    expect(dl!.sj_id).toBe(`${P}-d1`);

    // Listeners hear exactly what was written.
    expect(heard).toHaveLength(1);
    expect([...heard[0]!].sort()).toEqual([`${P}-d1`, `${P}-d2`, `${P}-d3`]);

    // Cursors: the max value read, per (table, field).
    const st = await db<{ table_name: string; cursor_field: string; cursor_value: Date }[]>`
      select table_name, cursor_field, cursor_value from erp_order_sync_state order by 1, 2`;
    const cur = Object.fromEntries(st.map((s) => [`${s.table_name}:${s.cursor_field}`, s.cursor_value.toISOString()]));
    expect(cur["do_header:updated_at"]).toBe("2026-11-10T10:02:00.000Z");
    expect(cur["request_produksi:created_at"]).toBe("2026-11-10T09:11:00.000Z");
    expect(cur["sales:updated_at"]).toBeUndefined();
  });

  it("an empty cursor starts backfillDays back; the next run asks from the stored cursor", async () => {
    const calls: { table: string; params: Record<string, string>; page: number }[] = [];
    const deps = {
      db, fetchPage: fakeFetcher(seedErp(), calls) as never, now: () => NOW, log: quiet,
      pageSize: 50, maxPagesPerTick: 10, backfillDays: 60, lookbackMinutes: 0,
    };
    await lane.runOrderSyncOnce(deps);
    expect(calls.find((c) => c.table === "do_header")!.params["updated_at__gte"]).toBe("2026-09-11 08:00:00");
    calls.length = 0;
    await lane.runOrderSyncOnce(deps);
    expect(calls.find((c) => c.table === "do_header")!.params["updated_at__gte"]).toBe("2026-11-10 10:02:00");
    expect(calls.find((c) => c.table === "do_header")!.params["order_by"]).toBe("updated_at");
    // Idempotent: still three DOs.
    expect(await db`select 1 from erp_do_header where id like ${`${P}%`}`).toHaveLength(3);
  });

  it("includeSlow reads the rep master", async () => {
    await lane.runOrderSyncOnce({
      includeSlow: true, db, fetchPage: fakeFetcher(seedErp(), []) as never, now: () => NOW, log: quiet,
      pageSize: 50, maxPagesPerTick: 10, backfillDays: 60, lookbackMinutes: 0,
    });
    const [s] = await db`select sales_name, active, phone from erp_sales where id = ${`${P}-s55`}`;
    expect(s).toEqual({ sales_name: "Free Antony", active: "Yes", phone: null });
  });

  it("a failing table records its error, keeps its cursor, and does not stop the others", async () => {
    const r = await lane.runOrderSyncOnce({
      db, fetchPage: fakeFetcher(seedErp(), [], ["do_header"]) as never, now: () => NOW, log: quiet,
      pageSize: 50, maxPagesPerTick: 10, backfillDays: 60, lookbackMinutes: 0,
    });
    expect(r.results.find((x) => x.table === "do_header")!.error).toContain("HTTP 500");
    expect(await db`select 1 from erp_request_produksi where id like ${`${P}%`}`).toHaveLength(2);
    const [st] = await db<{ cursor_value: Date; last_error: string; last_ok_at: Date | null }[]>`
      select cursor_value, last_error, last_ok_at from erp_order_sync_state where table_name = 'do_header'`;
    expect(st!.last_error).toContain("HTTP 500");
    expect(st!.last_ok_at).toBeNull();
    expect(st!.cursor_value.toISOString()).toBe("2026-09-11T08:00:00.000Z"); // the backfill start, not advanced
  });

  it("another holder of the lease makes the run skip", async () => {
    await db`update erp_order_sync_lease set owner = 'someone-else', lease_until = now() + interval '1 minute' where id = 1`;
    const r = await lane.runOrderSyncOnce({ db, fetchPage: fakeFetcher(seedErp(), []) as never, log: quiet });
    expect(r).toMatchObject({ ran: false, skipped: "locked" });
  });

  it("refreshOrderRow writes one row, and marks a vanished DO deleted when told so", async () => {
    const erp = seedErp();
    const r1 = await lane.refreshOrderRow("do_header", `${P}-d1`, { db, fetchPage: fakeFetcher(erp, []) as never, log: quiet });
    expect(r1).toMatchObject({ found: true, markedDeleted: false });
    erp.do_header = [];
    const r2 = await lane.refreshOrderRow("do_header", `${P}-d1`, { deleted: true, db, fetchPage: fakeFetcher(erp, []) as never, log: quiet });
    expect(r2).toMatchObject({ found: false, markedDeleted: true });
    const [d] = await db`select deleted_at is not null as deleted from erp_do_header where id = ${`${P}-d1`}`;
    expect(d!.deleted).toBe(true);
  });

  describe("POST /api/erp/webhook", () => {
    const build = async () => {
      const app = Fastify();
      await app.register(hook.erpWebhookRoutes);
      return app;
    };
    const post = async (body: string, sig?: string) =>
      (await build()).inject({
        method: "POST",
        url: "/api/erp/webhook",
        headers: { "content-type": "application/json", ...(sig ? { "x-selaras-signature": sig } : {}) },
        payload: body,
      });

    it("rejects a bad signature and an unknown table", async () => {
      const body = JSON.stringify({ table: "tbl_1082_SOLogisticPID", id: `${P}-w1`, action: "insert" });
      expect((await post(body, "0".repeat(64))).statusCode).toBe(401);
      expect((await post(body)).statusCode).toBe(401);
      const bad = JSON.stringify({ table: "tbl_1210_STLiveFGMX", id: "1" });
      expect((await post(bad, hook.signWebhook("whsec_test_123456", bad))).statusCode).toBe(400);
    });

    it("re-reads the row from the ERP and mirrors it", async () => {
      webhookRow = { tbl_1082_SOLogisticPID_id: `${P}-w1`, so_no: `${P}/SO-9`, no_sj: "KP/DO-W1", sj_date: "2026-11-12", cancel_order: "No", updated_at: "2026-11-10 11:00:00" };
      const body = JSON.stringify({ table: "tbl_1082_SOLogisticPID", id: `${P}-w1`, action: "insert" });
      const res = await post(body, hook.signWebhook("whsec_test_123456", body));
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, table: "do_header", found: true });
      const [d] = await db`select no_sj from erp_do_header where id = ${`${P}-w1`}`;
      expect(d!.no_sj).toBe("KP/DO-W1");
      webhookRow = null;
    });
  });
});

describe("webhook disabled without a secret", () => {
  afterEach(() => {
    process.env["ERP_WEBHOOK_SECRET"] = "whsec_test_123456";
  });
  it("answers 503", async () => {
    const { vi } = await import("vitest");
    vi.resetModules();
    process.env["ERP_WEBHOOK_SECRET"] = "";
    const fresh = await import("../src/routes/erp-webhook.js");
    const app = Fastify();
    await app.register(fresh.erpWebhookRoutes);
    const r = await app.inject({ method: "POST", url: "/api/erp/webhook", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(r.statusCode).toBe(503);
  });
});
