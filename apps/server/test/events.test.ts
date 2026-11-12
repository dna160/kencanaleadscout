/**
 * Kabar Pesanan WP-3: the order event deriver.
 *
 * Pure rules always run; the store, sweep, so.late and lane wiring need
 * DATABASE_URL and skip without it.
 */
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  deriveEvents,
  deriveFromDo,
  deriveFromHeader,
  deriveFromRequest,
  deriveLate,
  type DoFacts,
  type HeaderFacts,
  type RequestFacts,
} from "../src/events/derive.js";

const OPTS = { cancelledStatuses: ["Cancelled", "Void", "Batal"] };

const header = (over: Partial<HeaderFacts> = {}): HeaderFacts => ({
  id: "75001",
  po_no: "SO.26/12821",
  po_date: "2026-11-10",
  status_order: "Wating",
  customer_name_id: "4411",
  customer_name_text: "FITRAH JAYA",
  customer_final_id: "4411",
  sales_name_id: "55",
  sales_name_text: "Free Antony",
  top_limit: "Cash before Delivery",
  erp_created_at: new Date("2026-11-10T09:00:00Z"),
  ...over,
});
const request = (over: Partial<RequestFacts> = {}): RequestFacts => ({
  id: "9065",
  so_no: "SO.26/12821",
  so_ms: "SO",
  wo_no: "WO.26/00041",
  no_request: "REQNO-1",
  tanggal_request: "2026-11-10",
  erp_created_at: new Date("2026-11-10T10:00:00Z"),
  deleted_at: null,
  ...over,
});
const dOrder = (over: Partial<DoFacts> = {}): DoFacts => ({
  id: "77930",
  so_no: "SO.26/12821",
  no_sj: "KP/DO-13224/11/26",
  sj_date: "2026-11-11",
  do_created_at: new Date("2026-11-10T15:00:00Z"),
  cara_kirim: "di Antar",
  cancel_order: "No",
  erp_created_at: new Date("2026-11-10T15:00:00Z"),
  erp_updated_at: new Date("2026-11-10T15:00:00Z"),
  deleted_at: null,
  ...over,
});

describe("derivation rules (pure)", () => {
  it("so.created: keyed on po_no, carries routing facts, never a phone", () => {
    const [e] = deriveFromHeader(header(), OPTS);
    expect(e).toMatchObject({ event_key: "so.created:SO.26/12821", event_type: "so.created", so_no: "SO.26/12821", subject_ref: "75001" });
    expect(e!.payload).toMatchObject({ customer_name: "FITRAH JAYA", sales_name_id: "55", top_limit: "Cash before Delivery" });
    expect(JSON.stringify(e)).not.toMatch(/kontak|phone|08\d{2}/);
  });
  it("so.created: nothing for a cancelled status (case-insensitive) or a missing SO number", () => {
    expect(deriveFromHeader(header({ status_order: "batal" }), OPTS)).toEqual([]);
    expect(deriveFromHeader(header({ po_no: null }), OPTS)).toEqual([]);
    expect(deriveFromHeader(header({ po_no: "  " }), OPTS)).toEqual([]);
  });

  it("production.requested: only so_ms = SO, keyed on SO + WO", () => {
    expect(deriveFromRequest(request())[0]!.event_key).toBe("production.requested:SO.26/12821:WO.26/00041");
    expect(deriveFromRequest(request({ wo_no: null }))[0]!.event_key).toBe("production.requested:SO.26/12821:req-9065");
    expect(deriveFromRequest(request({ so_ms: "MS" }))).toEqual([]);
    expect(deriveFromRequest(request({ so_no: null }))).toEqual([]);
    expect(deriveFromRequest(request({ deleted_at: new Date() }))).toEqual([]);
  });

  it("do.created: keyed on no_sj, with sj_date and the pickup flag", () => {
    const [e] = deriveFromDo(dOrder({ cara_kirim: "di Ambil" }));
    expect(e).toMatchObject({ event_key: "do.created:KP/DO-13224/11/26", event_type: "do.created", so_no: "SO.26/12821" });
    expect(e!.payload).toMatchObject({ sj_date: "2026-11-11", pickup: true });
    expect(deriveFromDo(dOrder())[0]!.payload).toMatchObject({ pickup: false });
  });
  it("do.cancelled: on cancel_order = Yes or a deletion, never alongside do.created", () => {
    const [c] = deriveFromDo(dOrder({ cancel_order: "Yes" }));
    expect(c).toMatchObject({ event_key: "do.cancelled:KP/DO-13224/11/26", event_type: "do.cancelled" });
    expect(c!.payload).toMatchObject({ reason: "cancel_order" });
    const [d] = deriveFromDo(dOrder({ deleted_at: new Date("2026-11-10T16:00:00Z") }));
    expect(d!.payload).toMatchObject({ reason: "deleted" });
    expect(deriveFromDo(dOrder({ cancel_order: "YES" }))).toHaveLength(1);
  });
  it("a DO naming no SO is not created (nothing to route), but its cancellation is still a fact", () => {
    expect(deriveFromDo(dOrder({ so_no: null }))).toEqual([]);
    expect(deriveFromDo(dOrder({ so_no: null, cancel_order: "Yes" }))).toHaveLength(1);
    expect(deriveFromDo(dOrder({ no_sj: null }))[0]!.event_key).toBe("do.created:id-77930");
  });

  it("so.late: keyed on the earliest passed ETA, so a further slip is a new fact", () => {
    expect(deriveLate({ po_no: "SO.1", earliest_eta: "2026-11-01", lines: 2, balance: 30 }).event_key).toBe("so.late:SO.1:2026-11-01");
  });

  it("deriving the same batch twice yields identical keys (replay-safe)", () => {
    const input = { headers: [header(), header()], requests: [request()], dos: [dOrder(), dOrder({ id: "2", no_sj: "KP/DO-2", cancel_order: "Yes" })] };
    const a = deriveEvents(input, OPTS).map((e) => e.event_key);
    const b = deriveEvents(input, OPTS).map((e) => e.event_key);
    expect(a).toEqual(b);
    expect(a).toEqual([
      "so.created:SO.26/12821",
      "production.requested:SO.26/12821:WO.26/00041",
      "do.created:KP/DO-13224/11/26",
      "do.cancelled:KP/DO-2",
    ]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);
const P = "wp3ev";

describe.skipIf(!hasDb)("event store over the real schema", async () => {
  const dbmod = await import("../src/db/client.js");
  const store = await import("../src/events/store.js");
  const lane = await import("../src/erp/orderSync.js");
  const runner = await import("../src/events/runner.js");
  const routes = await import("../src/routes/order-events.js");
  const { runErpStockMigrations } = await import("../src/db/migrateErpStock.js");
  const { runOrderMigrations } = await import("../src/db/migrateOrders.js");
  const { runEventMigrations } = await import("../src/db/migrateEvents.js");
  const { canonicalSkuKey } = await import("../src/erp/sku.js");

  let db: NonNullable<ReturnType<typeof dbmod.getSql>>;
  const SO = `${P}/SO-1`;

  async function cleanup(): Promise<void> {
    await db`delete from order_events where event_key like ${`%${P}%`}`;
    await db`delete from erp_so_line where id like ${`${P}%`}`;
    await db`delete from erp_so_header where id like ${`${P}%`}`;
    await db`delete from erp_do_header where id like ${`${P}%`}`;
    await db`delete from erp_request_produksi where id like ${`${P}%`}`;
    await db`update order_event_state set swept_until = null, late_swept_at = null where id = 1`;
    await db`update erp_order_sync_lease set owner = null, lease_until = null where id = 1`;
  }
  async function insertHeader(id: string, poNo: string, createdDaysAgo = 0): Promise<void> {
    await db`
      insert into erp_so_header (id, po_no, so_number, customer_name_text, status_order, erp_created_at, kontak_penerima)
      values (${id}, ${poNo}, ${poNo}, ${"FITRAH JAYA"}, ${"Wating"},
              now() - make_interval(days => ${createdDaysAgo}), ${"0812-8311-4455"})
    `;
  }
  async function insertDo(id: string, noSj: string, cancel = "No"): Promise<void> {
    await db`
      insert into erp_do_header (id, so_no, no_sj, sj_date, cara_kirim, cancel_order, do_created_at, erp_updated_at)
      values (${id}, ${SO}, ${noSj}, current_date + 1, ${"di Antar"}, ${cancel}, now(), now())
      on conflict (id) do update set cancel_order = excluded.cancel_order, erp_updated_at = now(), synced_at = now()
    `;
  }
  const keysFor = async () =>
    (await db<{ event_key: string; source: string }[]>`
      select event_key, source from order_events where event_key like ${`%${P}%`} order by event_key`);

  beforeAll(async () => {
    const s = dbmod.getSql();
    if (!s) throw new Error("DATABASE_URL is set but getSql() returned null");
    db = s;
    await runErpStockMigrations(db);
    await runOrderMigrations(db);
    await runEventMigrations(db);
  }, 60_000);
  beforeEach(async () => {
    lane.resetOrderLaneForTests();
    await cleanup();
  });
  afterAll(async () => {
    await cleanup();
    await runner.stopEventDeriver();
    await dbmod.closeDatabase();
  });

  it("deriveForTouched twice records each fact once", async () => {
    await insertHeader(`${P}-h1`, SO);
    await insertDo(`${P}-d1`, `${P}/DO-1`);
    const touched = { ...lane.emptyTouched(), so_header: [`${P}-h1`], do_header: [`${P}-d1`] };
    const first = await store.deriveForTouched(db, touched);
    const again = await store.deriveForTouched(db, touched);
    expect(first.map((e) => e.event_type).sort()).toEqual(["do.created", "so.created"]);
    expect(again).toEqual([]);
    expect((await keysFor()).map((k) => k.event_key)).toEqual([`do.created:${P}/DO-1`, `so.created:${SO}`]);
    const [ev] = await db`select payload from order_events where event_key = ${`so.created:${SO}`}`;
    expect(JSON.stringify(ev!.payload)).not.toContain("8311");
  });

  it("rows created before the horizon produce no events", async () => {
    await insertHeader(`${P}-old`, `${P}/SO-OLD`, 400);
    await store.deriveForTouched(db, { ...lane.emptyTouched(), so_header: [`${P}-old`] });
    expect(await keysFor()).toEqual([]);
  });

  it("a DO cancelled later adds do.cancelled and keeps do.created", async () => {
    await insertDo(`${P}-d2`, `${P}/DO-2`);
    const touched = { ...lane.emptyTouched(), do_header: [`${P}-d2`] };
    await store.deriveForTouched(db, touched);
    await insertDo(`${P}-d2`, `${P}/DO-2`, "Yes");
    await store.deriveForTouched(db, touched);
    expect((await keysFor()).map((k) => k.event_key)).toEqual([`do.cancelled:${P}/DO-2`, `do.created:${P}/DO-2`]);
  });

  it("the sweep catches rows written by either sync loop, once, and advances its watermark", async () => {
    await insertHeader(`${P}-h2`, `${P}/SO-2`); // as the stock sync would write it: no listener ran
    const s1 = await store.sweepEvents(db);
    expect(s1.inserted.map((e) => e.event_key)).toContain(`so.created:${P}/SO-2`);
    const s2 = await store.sweepEvents(db);
    expect(s2.inserted.filter((e) => e.event_key.includes(P))).toEqual([]);
    const [st] = await db<{ swept_until: Date }[]>`select swept_until from order_event_state where id = 1`;
    expect(st!.swept_until.getTime()).toBe(s2.sweptUntil.getTime());
  });

  it("so.late: a live line with a passed ETA, recorded once per ETA", async () => {
    await insertHeader(`${P}-h3`, `${P}/SO-3`);
    const parts = { brand: "WP3", warna: "993", th: 0.21, th_panel: 4, p: 2440, l: 1220 };
    await db`
      insert into erp_so_line (id, po_no, brand, warna, th, th_panel, p, l, qty_order, qty_delivered, qty_balance,
                               status_order, approval, estimate_delivery, sku_key)
      values (${`${P}-l3`}, ${`${P}/SO-3`}, ${"WP3"}, ${"993"}, ${0.21}, ${4}, ${2440}, ${1220}, ${10}, ${0}, ${10},
              ${"Open"}, ${"Approved"}, current_date - 3, ${canonicalSkuKey(parts)})
    `;
    const first = await store.sweepLate(db);
    const mine = first.filter((e) => e.so_no === `${P}/SO-3`);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.event_key).toMatch(new RegExp(`^so\\.late:${P}/SO-3:\\d{4}-\\d{2}-\\d{2}$`));
    expect((await store.sweepLate(db)).filter((e) => e.so_no === `${P}/SO-3`)).toEqual([]);
    expect(await store.lateSweepDue(db, 30)).toBe(false);
  });

  it("the order lane and the webhook path both feed the deriver, with their source", async () => {
    runner.startEventDeriver();
    const erp: Record<string, Record<string, unknown>[]> = {
      so_header: [{ tbl_1202_SOSalesOrderNID_id: `${P}-h4`, po_no: `${P}/SO-4`, created_at: fmt(new Date()), updated_at: fmt(new Date()) }],
      do_header: [{ tbl_1082_SOLogisticPID_id: `${P}-d4`, so_no: `${P}/SO-4`, no_sj: `${P}/DO-4`, cancel_order: "No", created_at: fmt(new Date()), updated_at: fmt(new Date()) }],
    };
    const fetchPage = async (table: string, o: { params: Record<string, string> }) => {
      const pk = Object.keys(o.params).find((k) => k.endsWith("_id"));
      const rows = (erp[table] ?? []).filter((r) => !pk || String(r[pk]) === o.params[pk]);
      return { ok: true as const, rows, totalPages: 1, rateLimited: false };
    };
    const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
    // What a lane run does after a page: write, then emit to listeners. Done
    // directly (not runOrderSyncOnce) so this suite never contends for the lane
    // lease with orderLane.test.ts, which runs in parallel; the run → emit hop
    // itself is covered there.
    const touched = lane.emptyTouched();
    for (const t of ["so_header", "do_header"] as const) {
      const rows = erp[t]!.map((r) => lane.adaptLaneRow(t, r)!);
      touched[t] = await db.begin((tx) => lane.writeLaneRows(tx, t, rows));
    }
    await lane.emitOrderRows(touched, db, quiet, "erp-mirror");
    expect(await keysFor()).toEqual([
      { event_key: `do.created:${P}/DO-4`, source: "erp-mirror" },
      { event_key: `so.created:${P}/SO-4`, source: "erp-mirror" },
    ]);

    erp.do_header = [{ ...erp.do_header![0]!, cancel_order: "Yes", updated_at: fmt(new Date()) }];
    await lane.refreshOrderRow("do_header", `${P}-d4`, { db, fetchPage: fetchPage as never, log: quiet });
    expect((await keysFor()).find((k) => k.event_key === `do.cancelled:${P}/DO-4`)).toEqual({
      event_key: `do.cancelled:${P}/DO-4`,
      source: "erp-webhook",
    });
    await runner.stopEventDeriver();
  });

  it("GET /api/orders/events filters by SO and type", async () => {
    await insertHeader(`${P}-h5`, `${P}/SO-5`);
    await store.deriveForTouched(db, { ...lane.emptyTouched(), so_header: [`${P}-h5`] });
    const app = Fastify();
    await app.register(routes.orderEventRoutes);
    const r = await app.inject({ method: "GET", url: `/api/orders/events?so_no=${encodeURIComponent(`${P}/SO-5`)}&type=so.created` });
    expect(r.statusCode).toBe(200);
    expect(r.json().rows.map((x: { event_key: string }) => x.event_key)).toEqual([`so.created:${P}/SO-5`]);
    expect((await app.inject({ method: "GET", url: "/api/orders/events?type=nope" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/api/orders/sync-status" })).statusCode).toBe(200);
  });
});

/** An ERP-style naive datetime (wall clock digits = the Date's UTC digits). */
function fmt(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}
