/**
 * WP-7 · The HTTP surface of Stock 2.0 — CONTRACTS §4 and AMENDMENTS 1–10.
 *
 * ROLLOUT §7 X3: `atp.test.ts` proves the ATP *arithmetic*; nothing proved its
 * *serialization*. This file is gate G8. It drives the real routes over the real
 * schema through `app.inject()` — no port is bound, no HTTP stack is faked, and
 * every assertion that concerns a write reads the row back afterwards. A status
 * code on its own is not evidence that anything happened, and for `close-batch`
 * a status code on its own is not evidence that nothing happened either.
 *
 * WHAT IS DELIBERATELY NOT RE-SPELLED HERE
 * The liveness predicate (§7.3) lives in `v_live_commitments`. This file never
 * states it; it seeds lines with an ETA offset and asks the routes where they
 * landed. A change to the rule therefore changes these answers, which is the
 * only way a test can actually catch one.
 *
 * ISOLATION — the same idiom as `atp.test.ts`, extended to cover a route.
 * The shared database already holds other packages' Black Galaxy fixtures on
 * `ACP-4MM|004|0.3|4880|1220`, and a prior run was silently corrupted by them.
 * So:
 *   1. Every row this file writes carries the `wp7rt` prefix, and every SKU it
 *      asserts on is minted under a `WP7RT-*` kode_barang that no other package
 *      uses. Assertions locate their own rows; they never read a global total.
 *   2. Everything runs inside ONE transaction that is always rolled back. The
 *      routes read `getSql()`, which is mocked to hand back that transaction,
 *      so the handler and the test see the same uncommitted rows and NOTHING
 *      survives the test. A rerun on a dirty database gives the same result.
 *   3. `db.begin()` inside a transaction is mapped to `savepoint`, which is what
 *      a nested transaction is in Postgres. That is also the hook used to inject
 *      a mid-batch failure without touching a line of source.
 *
 * Without DATABASE_URL the DB block SKIPS rather than fails — CI may have no
 * database, and a red suite for an absent optional dependency is noise.
 */
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// ── module mocks (hoisted above every import below) ──────────────────────────

/**
 * `hasErp` is a module-level constant computed from the environment at import
 * time, so `POST /sync`'s two failure modes cannot both be reached in one file
 * without a seam. A getter is that seam and nothing else about config moves.
 */
const erp = vi.hoisted(() => ({ connected: false }));

/**
 * The route's database handle. `holder.tx` is set for the duration of one
 * rolled-back transaction; outside of one the real pool is returned so that
 * `beforeAll`/`afterAll` bookkeeping still works.
 */
const holder = vi.hoisted(() => ({ tx: null as unknown }));

vi.mock("../src/config.js", async () => {
  const actual = await vi.importActual<typeof import("../src/config.js")>("../src/config.js");
  return {
    ...actual,
    get hasErp() {
      return erp.connected;
    },
  };
});

vi.mock("../src/db/client.js", async () => {
  const actual = await vi.importActual<typeof import("../src/db/client.js")>("../src/db/client.js");
  return { ...actual, getSql: () => holder.tx ?? actual.getSql() };
});

import { canonicalSkuKey, type SkuParts } from "../src/erp/sku.js";
import { closeDatabase, getSql } from "../src/db/client.js";
import { runErpStockMigrations } from "../src/db/migrateErpStock.js";
import { stockAtpRoutes } from "../src/routes/stock-atp.js";
import { stockRoutes } from "../src/routes/stock.js";
import type {
  AdjustmentRow,
  BatchCloseResponse,
  CommitLine,
  OverrideResponse,
  PagedResponse,
  SkuDetailResponse,
  SkuItem,
  SummaryResponse,
  SyncStatusResponse,
} from "../src/routes/stock-atp.js";

const hasDb = Boolean(process.env.DATABASE_URL);

/** Everything this file writes is prefixed, so a leaked row is identifiable. */
const P = "wp7rt";
const ACTOR = `${P}.ppic`;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tx = any;

// ── the rollback harness ─────────────────────────────────────────────────────

class Rollback extends Error {
  constructor() {
    super("wp7 route test rollback");
  }
}

/** Set for one `inRollback` block to make the route's `db.begin()` throw. */
let failNextBatch = false;

/**
 * A transaction-scoped `sql` from postgres.js carries `savepoint` but NOT
 * `begin` — `begin` is only ever attached to the pool. `close-batch` calls
 * `db.begin()`, so without this proxy the route would throw a TypeError instead
 * of exercising its transaction. Mapping it to `savepoint` is not a stub: a
 * savepoint IS the nested transaction, with the same rollback semantics.
 *
 * `failNextBatch` makes the mapped block reject AFTER the route's statement has
 * run. That is the only way to observe "all-or-nothing under failure" from the
 * outside: the insert really is attempted, the enclosing block really does
 * reject, and the test then asserts that nothing survived.
 */
function txProxy(tx: Tx): Tx {
  return new Proxy(tx, {
    apply(target: any, _thisArg, args: any[]) {
      return target(...args);
    },
    get(target: any, prop) {
      if (prop === "begin") {
        return (fn: (sql: Tx) => Promise<unknown>) =>
          target.savepoint(async (sp: Tx) => {
            const out = await fn(sp);
            if (failNextBatch) throw new Error(`${P} injected mid-transaction failure`);
            return out;
          });
      }
      const v = target[prop];
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

let realDb: ReturnType<typeof getSql>;
let app: FastifyInstance;

/**
 * Run `fn` inside a transaction that is always rolled back, with the routes
 * pointed at that same transaction for its duration.
 */
async function inRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await realDb!.begin(async (tx: Tx) => {
      holder.tx = txProxy(tx);
      try {
        out = await fn(tx);
      } finally {
        holder.tx = null;
        failNextBatch = false;
      }
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out;
}

// ── fixture builders ─────────────────────────────────────────────────────────

/**
 * A colour code nobody else in this database uses, and the name the mirrored
 * colour master (tbl_1228 → `erp_warna`) resolves it to. `warna` is an ID, not a
 * name (FIX 7): a row with no master entry must still render, showing the code.
 */
const WARNA_CODE = "907001";
const WARNA_NAME = "HITAM GALAKSI QA";

/** Mirror one colour-master row, so the display name resolves deterministically. */
async function seedWarna(tx: Tx): Promise<void> {
  await tx`
    insert into erp_warna (id, code, code_num, rm_warna)
    values (${`WP7RT-${WARNA_CODE}`}, ${WARNA_CODE}, ${Number(WARNA_CODE)}, ${WARNA_NAME})
    on conflict (id) do nothing
  `;
}

/** A SKU identity nobody else in this database uses. */
function parts(tag: string, over: Partial<SkuParts> = {}): SkuParts {
  // 2026-09-11 composition: brand|warna|th|th_panel|p|l (erp/sku.ts). `brand`
  // carries the suite's unique tag, since `kode_barang` is no longer in the key
  // (tbl_1203 has no such column) and could not isolate this suite's rows.
  return { brand: `WP7RT-${tag}`, warna: WARNA_CODE, th: 0.3, th_panel: 4, p: 4880, l: 1220, ...over };
}
function keyOf(tag: string, over: Partial<SkuParts> = {}): string {
  return canonicalSkuKey(parts(tag, over));
}

type FgRow = { sn_fg: string; qty: number; qty_m2?: number; lokasi?: string; parts: SkuParts };
type LineRow = {
  id: string;
  qty_balance: number;
  /** `null` ⇒ undated (AMENDMENT 1) · `number` ⇒ days before today · `string` ⇒ literal date. */
  eta: number | string | null;
  parts: SkuParts;
  approval?: string;
  status_order?: string;
  so_id?: string;
  customer?: string;
};

async function seedFg(tx: Tx, rows: readonly FgRow[]): Promise<void> {
  for (const r of rows) {
    const pa = r.parts;
    await tx`
      insert into erp_live_fg (
        erp_row_id, sn_fg, kode_barang, brand, warna, th, th_panel, p, l, qty, qty_m2, lokasi, sku_key
      ) values (
        ${r.sn_fg}, ${r.sn_fg}, ${String(pa.brand ?? "")}, ${String(pa.brand ?? "")},
        ${String(pa.warna ?? "")},
        ${Number(pa.th ?? 0)}, ${Number(pa.th_panel ?? 0)}, ${Number(pa.p ?? 0)}, ${Number(pa.l ?? 0)},
        ${r.qty}, ${r.qty_m2 ?? null}, ${r.lokasi ?? "GD-A"}, ${canonicalSkuKey(pa)}
      )
    `;
  }
}

async function seedLines(tx: Tx, rows: readonly LineRow[]): Promise<void> {
  for (const r of rows) {
    const pa = r.parts;
    const soId = r.so_id ?? `${P}-so`;
    await tx`
      insert into erp_so_header (id, so_number, customer_name_text, sales_name_text, status_order)
      values (${soId}, ${`SO-${soId}`}, ${r.customer ?? "PT Pelanggan QA"}, ${"Rep QA"}, ${"Open"})
      on conflict (id) do nothing
    `;
    // ETA as an offset so fixtures move with `current_date` exactly as the view
    // window does — never a literal that drifts past the boundary next quarter.
    const eta =
      r.eta === null ? null : typeof r.eta === "number" ? tx`(current_date - ${r.eta}::int)` : tx`${r.eta}::date`;
    await tx`
      insert into erp_so_line (
        id, so_id, brand, warna, th, th_panel, p, l,
        qty_order, qty_delivered, qty_balance,
        status_order, approval, estimate_delivery, sn_fg, sku_key
      ) values (
        ${r.id}, ${soId}, ${String(pa.brand ?? "")}, ${String(pa.warna ?? "")},
        ${Number(pa.th ?? 0)}, ${Number(pa.th_panel ?? 0)}, ${Number(pa.p ?? 0)}, ${Number(pa.l ?? 0)},
        ${r.qty_balance}, ${0}, ${r.qty_balance},
        ${r.status_order ?? "Open"}, ${r.approval ?? "Approved"}, ${eta},
        ${null}, ${canonicalSkuKey(pa)}
      )
    `;
  }
}

async function seedAdjustment(tx: Tx, skuKey: string, delta: number): Promise<void> {
  await tx`
    insert into stock_adjustments (sku_key, qty_delta, reason, actor)
    values (${skuKey}, ${delta}, ${'opname qa'}, ${ACTOR})
  `;
}

// ── reading the effect back, straight from the tables ────────────────────────

async function overrideRows(tx: Tx): Promise<{ so_line_id: string; state: string; reason: string | null; actor: string }[]> {
  return tx`
    select so_line_id, state, reason, actor
    from stock_commitment_overrides
    where so_line_id like ${`${P}%`}
    order by so_line_id
  `;
}

async function adjustmentCount(tx: Tx): Promise<number> {
  const [r] = await tx`select count(*)::int as c from stock_adjustments where actor like ${`${P}%`}`;
  return (r as { c: number }).c;
}

/** The mirror must be byte-identical before and after any route call (§7.2). */
async function mirrorDigest(tx: Tx): Promise<{ fg: string | null; lines: string | null }> {
  const [r] = await tx`
    select
      (select md5(string_agg(t::text, '|' order by t.sn_fg)) from erp_live_fg t where t.sn_fg like ${`${P}%`}) as fg,
      (select md5(string_agg(t::text, '|' order by t.id))    from erp_so_line t where t.id    like ${`${P}%`}) as lines
  `;
  return r as { fg: string | null; lines: string | null };
}

// ── driving the routes ───────────────────────────────────────────────────────

async function GET<T>(url: string): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() as T };
}
async function POST<T>(url: string, payload: unknown): Promise<{ status: number; body: T }> {
  const res = await app.inject({ method: "POST", url, payload: payload as object });
  return { status: res.statusCode, body: res.json() as T };
}

async function summaryItem(skuKey: string): Promise<SkuItem | undefined> {
  const { body } = await GET<SummaryResponse>("/api/stock/summary");
  return body.items.find((i) => i.sku_key === skuKey);
}
async function atpOf(skuKey: string): Promise<number> {
  const it = await summaryItem(skuKey);
  return it ? it.atp : 0;
}

// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!hasDb)("Stock 2.0 HTTP surface (CONTRACTS §4 · ROLLOUT G8/X3)", () => {
  beforeAll(async () => {
    realDb = getSql();
    if (!realDb) throw new Error("DATABASE_URL is set but getSql() returned null");
    // Only migrate if the views are missing: three suites share this database and
    // concurrent `create or replace view` is a needless lock fight.
    const [v] = await realDb<{ n: number }[]>`
      select count(*)::int as n from information_schema.views
      where table_schema = 'public' and table_name in ('v_live_commitments', 'v_stale_commitments')
    `;
    if (!v || v.n < 2) await runErpStockMigrations(realDb);

    // The whole live module plus the 1.0 archive/tombstone file, exactly as
    // index.ts registers them. No port is bound.
    app = Fastify({ logger: false });
    await app.register(stockAtpRoutes);
    await app.register(stockRoutes);
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await closeDatabase();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 1 · close-batch — the most dangerous endpoint in the module (AMENDMENT 6b)
  //
  // An unguarded batch close releases thousands of live commitments in one
  // transaction, and every one of them is stock already owed to a customer.
  // Every test here reads the override table back; none of them trusts a 409.
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /stale-commitments/close-batch (AMENDMENT 6b)", () => {
    const A = parts("BAT-A"); // undated: closing RELEASES stock
    const B = parts("BAT-B"); // stale:   closing releases nothing
    const KA = canonicalSkuKey(A);
    const KB = canonicalSkuKey(B);

    /** 2 undated lines on A (40 + 60 reserving) and 1 stale line on B. */
    async function seedBatch(tx: Tx): Promise<void> {
      await seedFg(tx, [
        { sn_fg: `${P}-bat-fg-a`, qty: 500, parts: A },
        { sn_fg: `${P}-bat-fg-b`, qty: 300, parts: B },
      ]);
      await seedLines(tx, [
        { id: `${P}-bat-u1`, qty_balance: 40, eta: null, parts: A },
        { id: `${P}-bat-u2`, qty_balance: 60, eta: null, parts: A },
        { id: `${P}-bat-s1`, qty_balance: 90, eta: 400, parts: B },
      ]);
    }

    it("REGRESSION (HIGH): a line that went LIVE after selection is never closed", async () => {
      // The attack this guard exists for, reproduced exactly as the correctness
      // review found it:
      //   1. operator loads ?segment=stale and selects a stale line
      //   2. an ERP sync lands and pushes its estimate_delivery into the future,
      //      so the line is now LIVE and reserving stock for a real customer
      //   3. operator clicks Tutup with the id list from step 1
      // Before the fix the line closed and its whole balance became promiseable
      // again — the over-promising failure this module exists to prevent.
      //
      // `expected_count` cannot catch it: the client derives it from the same
      // array it posts, so it only ever compares a list's length to itself. The
      // membership test has to be part of the write, against the segment the
      // operator actually selected from.
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-race-fg`, qty: 1000, parts: A }]);
        await seedLines(tx, [{ id: `${P}-race-1`, qty_balance: 500, eta: 400, parts: A }]);

        // Step 1 — stale, so it is excluded from ATP and the queue offers it.
        expect(await atpOf(KA)).toBe(1000);

        // Step 2 — the sync moves it. It is now live, dated, and reserving.
        await tx`update erp_so_line set estimate_delivery = current_date + 7 where id = ${`${P}-race-1`}`;
        expect(await atpOf(KA)).toBe(500);

        // Step 3 — the stale click lands.
        const { status, body } = await POST<BatchCloseResponse>("/api/stock/stale-commitments/close-batch", {
          so_line_ids: [`${P}-race-1`],
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 1,
          segment: "stale",
        });

        // Refused: nothing in the stale segment matched.
        expect(status).toBe(409);
        expect(await overrideRows(tx)).toEqual([]);

        // THE ASSERTION THAT MATTERS: the commitment still reserves. 500 lembar
        // owed to a customer did not become promiseable.
        expect(await atpOf(KA)).toBe(500);

        // And it is still refused when the batch spans the whole review queue —
        // a live dated line is in neither population.
        const wide = await POST<BatchCloseResponse>("/api/stock/stale-commitments/close-batch", {
          so_line_ids: [`${P}-race-1`],
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 1,
        });
        expect(wide.status).toBe(409);
        expect(await atpOf(KA)).toBe(500);
      });
    });

    it("REGRESSION (D9 fixed): blank entries are refused, not silently dropped", async () => {
      // `["id", "", null]` with expected_count 3 used to pass the guard and close
      // one row — the declared count and the number released disagreeing, which
      // is the one property expected_count exists to preserve.
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const { status } = await POST<{ error: string }>("/api/stock/stale-commitments/close-batch", {
          so_line_ids: [`${P}-bat-u1`, "", null],
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 3,
        });
        expect(status).toBe(400);
        expect(await overrideRows(tx)).toEqual([]);
      });
    });

    it("a mismatched expected_count returns 409 AND writes nothing", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const atpBefore = { a: await atpOf(KA), b: await atpOf(KB) };
        const mirrorBefore = await mirrorDigest(tx);

        const { status, body } = await POST<{ error: string; expected_count: number; received_count: number }>(
          "/api/stock/stale-commitments/close-batch",
          { so_line_ids: [`${P}-bat-u1`, `${P}-bat-u2`], reason: "phantom lama", actor: ACTOR, expected_count: 7 },
        );

        expect(status).toBe(409);
        expect(body.error).toBe("Jumlah baris tidak cocok — daftar berubah. Muat ulang antrean.");
        expect(body.expected_count).toBe(7);
        expect(body.received_count).toBe(2);

        // THE ASSERTION THAT MATTERS. A 409 that still wrote is the failure mode
        // this guard exists to prevent, and the status code cannot reveal it.
        expect(await overrideRows(tx)).toEqual([]);
        expect(await atpOf(KA)).toBe(atpBefore.a);
        expect(await atpOf(KB)).toBe(atpBefore.b);
        expect(await mirrorDigest(tx)).toEqual(mirrorBefore);

        // And the lines are still in the queue, still reserving.
        const { body: undated } = await GET<PagedResponse<CommitLine>>(
          "/api/stock/stale-commitments?segment=undated&limit=500",
        );
        const ids = undated.items.map((r) => r.so_line_id);
        expect(ids).toContain(`${P}-bat-u1`);
        expect(ids).toContain(`${P}-bat-u2`);
      });
    });

    it("is all-or-nothing: a failure inside the transaction leaves every row open", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const atpBefore = await atpOf(KA);

        // Injected at the harness level — no source file is touched. The route's
        // insert runs, then the enclosing transaction rejects.
        failNextBatch = true;
        const res = await app.inject({
          method: "POST",
          url: "/api/stock/stale-commitments/close-batch",
          payload: {
            so_line_ids: [`${P}-bat-u1`, `${P}-bat-u2`, `${P}-bat-s1`],
            reason: "phantom lama",
            actor: ACTOR,
            expected_count: 3,
          },
        });
        failNextBatch = false;

        expect(res.statusCode).toBe(500);
        // Nothing partially closed: not one of the three, not the two that share
        // a SKU with each other.
        expect(await overrideRows(tx)).toEqual([]);
        expect(await atpOf(KA)).toBe(atpBefore);
      });
    });

    it("closes every id in one go and reports the real per-SKU ATP effect", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const beforeA = await atpOf(KA);
        const beforeB = await atpOf(KB);
        expect(beforeA).toBe(400); // 500 on hand − 100 reserved by the undated pair
        expect(beforeB).toBe(300); // the stale line reserves nothing to begin with

        const { status, body } = await POST<BatchCloseResponse>("/api/stock/stale-commitments/close-batch", {
          so_line_ids: [`${P}-bat-u1`, `${P}-bat-u2`, `${P}-bat-s1`],
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 3,
        });

        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.closed).toBe(3);
        expect(body.skipped).toEqual([]);

        // AMENDMENT 6b: the per-SKU effect, measured. The two populations differ,
        // and the number the UI states has to be the real one.
        expect(body.atp_delta_by_sku).toEqual({ [KA]: 100, [KB]: 0 });
        expect(await atpOf(KA)).toBe(beforeA + 100);
        expect(await atpOf(KB)).toBe(beforeB);

        // The rows exist, carry the audit fields, and the mirror is untouched.
        const rows = await overrideRows(tx);
        expect(rows.map((r) => r.so_line_id)).toEqual([`${P}-bat-s1`, `${P}-bat-u1`, `${P}-bat-u2`]);
        expect(rows.every((r) => r.state === "closed")).toBe(true);
        expect(rows.every((r) => r.actor === ACTOR && r.reason === "phantom lama")).toBe(true);
      });
    });

    it("ids absent from the mirror are skipped, not fatal", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const { status, body } = await POST<BatchCloseResponse>("/api/stock/stale-commitments/close-batch", {
          so_line_ids: [`${P}-bat-u1`, `${P}-ghost-1`, `${P}-ghost-2`],
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 3,
        });

        expect(status).toBe(200);
        expect(body.closed).toBe(1);
        expect(body.skipped).toEqual([
          { so_line_id: `${P}-ghost-1`, reason: "tidak_ditemukan" },
          { so_line_id: `${P}-ghost-2`, reason: "tidak_ditemukan" },
        ]);
        expect((await overrideRows(tx)).map((r) => r.so_line_id)).toEqual([`${P}-bat-u1`]);
      });
    });

    it("holds the 200-id cap, and a capped request writes nothing", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const ids = [`${P}-bat-u1`, ...Array.from({ length: 200 }, (_, i) => `${P}-ghost-${i}`)];
        expect(ids.length).toBe(201);

        const { status, body } = await POST<{ error: string }>("/api/stock/stale-commitments/close-batch", {
          so_line_ids: ids,
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 201,
        });
        expect(status).toBe(400);
        expect(body.error).toBe("Maksimum 200 baris sekali tutup.");
        expect(await overrideRows(tx)).toEqual([]);
      });
    });

    it("accepts exactly 200 ids — the cap is inclusive", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const ids = [`${P}-bat-u1`, ...Array.from({ length: 199 }, (_, i) => `${P}-ghost-${i}`)];
        expect(ids.length).toBe(200);
        const { status, body } = await POST<BatchCloseResponse>("/api/stock/stale-commitments/close-batch", {
          so_line_ids: ids,
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 200,
        });
        expect(status).toBe(200);
        expect(body.closed).toBe(1);
        expect(body.skipped.length).toBe(199);
      });
    });

    it("a reason shorter than 4 characters is rejected server-side (AMENDMENT 8)", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        for (const reason of ["", "   ", "ok", "abc"]) {
          const { status, body } = await POST<{ error: string }>("/api/stock/stale-commitments/close-batch", {
            so_line_ids: [`${P}-bat-u1`],
            reason,
            actor: ACTOR,
            expected_count: 1,
          });
          expect(status).toBe(400);
          expect(body.error).toBe("Alasan wajib diisi.");
        }
        expect(await overrideRows(tx)).toEqual([]);
      });
    });

    it("rejects a missing actor, an empty list and an absent expected_count, writing nothing", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const base = { so_line_ids: [`${P}-bat-u1`], reason: "phantom lama", actor: ACTOR, expected_count: 1 };

        const noActor = await POST<{ error: string }>("/api/stock/stale-commitments/close-batch", {
          ...base,
          actor: "",
        });
        expect(noActor.status).toBe(400);
        expect(noActor.body.error).toBe("Nama petugas wajib diisi.");

        const noIds = await POST<{ error: string }>("/api/stock/stale-commitments/close-batch", {
          ...base,
          so_line_ids: [],
        });
        expect(noIds.status).toBe(400);
        expect(noIds.body.error).toBe("Daftar baris SO wajib diisi.");

        const notAList = await POST<{ error: string }>("/api/stock/stale-commitments/close-batch", {
          ...base,
          so_line_ids: `${P}-bat-u1`,
        });
        expect(notAList.status).toBe(400);
        expect(notAList.body.error).toBe("Daftar baris SO wajib diisi.");

        const noCount = await POST<{ error: string }>("/api/stock/stale-commitments/close-batch", {
          so_line_ids: [`${P}-bat-u1`],
          reason: "phantom lama",
          actor: ACTOR,
        });
        expect(noCount.status).toBe(400);
        expect(noCount.body.error).toBe("Jumlah baris wajib disertakan.");

        // AMENDMENT 6b forbids a filter-shaped bulk close. There is no parameter
        // that selects rows by predicate: an id list is the only way in.
        const filterShaped = await POST<{ error: string }>("/api/stock/stale-commitments/close-batch", {
          segment: "stale",
          only_do: true,
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 999,
        });
        expect(filterShaped.status).toBe(400);

        expect(await overrideRows(tx)).toEqual([]);
      });
    });

    it("a batch of ids that are all unknown is a 404 and writes nothing", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const { status, body } = await POST<{ error: string }>("/api/stock/stale-commitments/close-batch", {
          so_line_ids: [`${P}-ghost-a`, `${P}-ghost-b`],
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 2,
        });
        expect(status).toBe(404);
        expect(body.error).toBe("Tidak ada baris Sales Order yang cocok.");
        expect(await overrideRows(tx)).toEqual([]);
      });
    });

    it("is idempotent: re-closing an already-closed batch moves ATP by 0", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const payload = {
          so_line_ids: [`${P}-bat-u1`, `${P}-bat-u2`],
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 2,
        };
        const first = await POST<BatchCloseResponse>("/api/stock/stale-commitments/close-batch", payload);
        expect(first.body.atp_delta_by_sku[KA]).toBe(100);

        const second = await POST<BatchCloseResponse>("/api/stock/stale-commitments/close-batch", payload);
        expect(second.status).toBe(200);
        expect(second.body.closed).toBe(2);
        // Already excluded, so the second close releases nothing more.
        expect(second.body.atp_delta_by_sku[KA]).toBe(0);
        expect((await overrideRows(tx)).length).toBe(2);
      });
    });

    it("REGRESSION (D5 fixed): a duplicated id is refused outright, and nothing is written", async () => {
      // A repeated id used to pass the guard and close one row, so the count the
      // client declared and the number of commitments actually released could
      // disagree — the single property this guard exists to keep true. The raw
      // length is still what `expected_count` is compared against; the duplicate
      // check now runs first, so the declared count, the unique count and the
      // number of closable rows are the same number by construction.
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const { status } = await POST<BatchCloseResponse>("/api/stock/stale-commitments/close-batch", {
          so_line_ids: [`${P}-bat-u1`, `${P}-bat-u1`],
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 2,
        });
        expect(status).toBe(409);
        expect((await overrideRows(tx)).length).toBe(0);
      });
    });

    it("never writes the erp_* mirror (§7.2)", async () => {
      await inRollback(async (tx) => {
        await seedBatch(tx);
        const before = await mirrorDigest(tx);
        await POST("/api/stock/stale-commitments/close-batch", {
          so_line_ids: [`${P}-bat-u1`, `${P}-bat-u2`, `${P}-bat-s1`],
          reason: "phantom lama",
          actor: ACTOR,
          expected_count: 3,
        });
        expect(await mirrorDigest(tx)).toEqual(before);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 2 · segment= on /stale-commitments (AMENDMENT 6c)
  //
  // A confirm-closed line leaves v_stale_commitments. Without `segment=closed`
  // the operator cannot find it again after a reload, so the undo path dies and
  // a confirm-close becomes unrecoverable from the UI.
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /stale-commitments?segment= (AMENDMENT 6c)", () => {
    const S = parts("SEG-S");
    const U = parts("SEG-U");

    async function seedSegments(tx: Tx): Promise<void> {
      await seedFg(tx, [
        { sn_fg: `${P}-seg-fg-s`, qty: 100, parts: S },
        { sn_fg: `${P}-seg-fg-u`, qty: 100, parts: U },
      ]);
      await seedLines(tx, [
        { id: `${P}-seg-stale`, qty_balance: 25, eta: 400, parts: S },
        { id: `${P}-seg-undated`, qty_balance: 35, eta: null, parts: U },
        { id: `${P}-seg-live`, qty_balance: 15, eta: 5, parts: U },
      ]);
    }

    async function idsFor(url: string): Promise<string[]> {
      const { body } = await GET<PagedResponse<CommitLine>>(url);
      return body.items.filter((r) => r.so_line_id.startsWith(P)).map((r) => r.so_line_id);
    }

    it("segment=stale is the default and holds only the stale line", async () => {
      await inRollback(async (tx) => {
        await seedSegments(tx);
        const withParam = await idsFor("/api/stock/stale-commitments?segment=stale&limit=500");
        const withoutParam = await idsFor("/api/stock/stale-commitments?limit=500");
        expect(withParam).toEqual([`${P}-seg-stale`]);
        expect(withoutParam).toEqual(withParam); // the default is `stale`
      });
    });

    it("segment=undated holds the AMENDMENT 1 live lines, with the qty the UI previews", async () => {
      await inRollback(async (tx) => {
        await seedSegments(tx);
        const { body } = await GET<PagedResponse<CommitLine>>("/api/stock/stale-commitments?segment=undated&limit=500");
        const mine = body.items.filter((r) => r.so_line_id.startsWith(P));
        expect(mine.map((r) => r.so_line_id)).toEqual([`${P}-seg-undated`]);
        const row = mine[0]!;
        // AMENDMENT 6c: the undated segment carries qty_balance and sku_key so the
        // UI can state "closing this releases N" before the operator taps.
        expect(row.qty_balance).toBe(35);
        expect(row.sku_key).toBe(canonicalSkuKey(U));
        expect(row.undated).toBe(true);
        expect(row.estimate_delivery).toBeNull();
        expect(row.state).toBe("live"); // it is reserving stock right now
        expect(row.age_days).toBeNull();
      });
    });

    it("segment=all is stale + undated together, and excludes the dated live line", async () => {
      await inRollback(async (tx) => {
        await seedSegments(tx);
        const all = await idsFor("/api/stock/stale-commitments?segment=all&limit=500");
        expect(all.sort()).toEqual([`${P}-seg-stale`, `${P}-seg-undated`].sort());
        expect(all).not.toContain(`${P}-seg-live`);
      });
    });

    it("segment=closed recovers a confirm-closed line — the undo path (AMENDMENT 6c)", async () => {
      await inRollback(async (tx) => {
        await seedSegments(tx);
        expect(await idsFor("/api/stock/stale-commitments?segment=closed&limit=500")).toEqual([]);

        const closed = await POST<OverrideResponse>(
          `/api/stock/stale-commitments/${P}-seg-stale/close`,
          { actor: ACTOR, reason: "phantom lama" },
        );
        expect(closed.status).toBe(200);

        // It has left the stale queue…
        expect(await idsFor("/api/stock/stale-commitments?segment=stale&limit=500")).toEqual([]);
        // …and is findable again, which is the entire point: this is what a page
        // reload has to be able to do before reinstate is reachable.
        const back = await GET<PagedResponse<CommitLine>>("/api/stock/stale-commitments?segment=closed&limit=500");
        const row = back.body.items.find((r) => r.so_line_id === `${P}-seg-stale`);
        expect(row).toBeDefined();
        expect(row!.state).toBe("closed");
        expect(row!.override).not.toBeNull();
        expect(row!.override!.state).toBe("closed");
        expect(row!.override!.actor).toBe(ACTOR);
        expect(row!.override!.reason).toBe("phantom lama");

        // And reinstate, reached from that row, actually puts it back.
        const un = await POST<OverrideResponse>(
          `/api/stock/stale-commitments/${P}-seg-stale/reinstate`,
          { actor: ACTOR },
        );
        expect(un.status).toBe(200);
        expect(await idsFor("/api/stock/stale-commitments?segment=closed&limit=500")).toEqual([]);
        expect(await idsFor("/api/stock/stale-commitments?segment=stale&limit=500")).toEqual([`${P}-seg-stale`]);
      });
    });

    it("a closed undated line is recoverable too, and reinstating it re-reserves the stock", async () => {
      await inRollback(async (tx) => {
        await seedSegments(tx);
        const KU = canonicalSkuKey(U);
        const before = await atpOf(KU);

        await POST(`/api/stock/stale-commitments/${P}-seg-undated/close`, { actor: ACTOR, reason: "phantom lama" });
        expect(await atpOf(KU)).toBe(before + 35);
        expect(await idsFor("/api/stock/stale-commitments?segment=undated&limit=500")).toEqual([]);

        const closedIds = await idsFor("/api/stock/stale-commitments?segment=closed&limit=500");
        expect(closedIds).toEqual([`${P}-seg-undated`]);

        await POST(`/api/stock/stale-commitments/${P}-seg-undated/reinstate`, { actor: ACTOR });
        expect(await atpOf(KU)).toBe(before);
        expect(await idsFor("/api/stock/stale-commitments?segment=undated&limit=500")).toEqual([`${P}-seg-undated`]);
      });
    });

    it("an unknown segment value falls back to `stale` rather than erroring", async () => {
      await inRollback(async (tx) => {
        await seedSegments(tx);
        const { body } = await GET<PagedResponse<CommitLine> & { segment: string }>(
          "/api/stock/stale-commitments?segment=bogus&limit=500",
        );
        expect(body.segment).toBe("stale");
        expect(body.items.filter((r) => r.so_line_id.startsWith(P)).map((r) => r.so_line_id)).toEqual([
          `${P}-seg-stale`,
        ]);
      });
    });

    it("the shipped `state=closed` spelling still resolves (compatibility alias)", async () => {
      await inRollback(async (tx) => {
        await seedSegments(tx);
        await POST(`/api/stock/stale-commitments/${P}-seg-stale/close`, { actor: ACTOR, reason: "phantom lama" });
        const { body } = await GET<PagedResponse<CommitLine> & { segment: string }>(
          "/api/stock/stale-commitments?state=closed&limit=500",
        );
        expect(body.segment).toBe("closed");
        expect(body.items.map((r) => r.so_line_id)).toContain(`${P}-seg-stale`);
      });
    });

    async function seedDoQueue(tx: Tx): Promise<void> {
      await seedFg(tx, [{ sn_fg: `${P}-do-fg`, qty: 10, parts: parts("SEG-DO") }]);
      await seedLines(tx, [
        { id: `${P}-do-1`, qty_balance: 5, eta: 400, parts: parts("SEG-DO"), status_order: "DO" },
        { id: `${P}-do-2`, qty_balance: 5, eta: 400, parts: parts("SEG-DO"), status_order: "Waiting" },
      ]);
    }

    it("`status_order=` narrows the queue by SO status", async () => {
      await inRollback(async (tx) => {
        await seedDoQueue(tx);
        const { body } = await GET<PagedResponse<CommitLine>>(
          "/api/stock/stale-commitments?segment=stale&status_order=DO&limit=500",
        );
        const mine = body.items.filter((r) => r.so_line_id.startsWith(`${P}-do-`));
        expect(mine.map((r) => r.so_line_id)).toEqual([`${P}-do-1`]);
      });
    });

    it("REGRESSION (D2 fixed): `status` and `only_do` actually filter", async () => {
      // AMENDMENT 8 ratifies `status` (status_order filter) and `only_do`
      // (ST-R22: status_order='DO' with a balance) as final names on
      // /stale-commitments. The handler declares neither — its querystring type
      // reads `status_order` and there is no `only_do` branch anywhere — so both
      // are dropped and the full queue comes back.
      //
      // The shipped PPIC page sends exactly `status` and `only_do`
      // (`lmQuery()` in apps/server/public/stock-ppic.html), so the status filter
      // and the ST-R22 "known-dead phantoms only" toggle both appear to work and
      // change nothing. That is the worse half: a bulk close launched from a
      // queue the operator believes is filtered to DO rows is a queue that still
      // contains everything else, and `close-batch` will close exactly the ids it
      // is handed. Owning file: apps/server/src/routes/stock-atp.ts
      // (GET /api/stock/stale-commitments querystring + loadCommitments).
      await inRollback(async (tx) => {
        await seedDoQueue(tx);
        const asShipped = await GET<PagedResponse<CommitLine>>(
          "/api/stock/stale-commitments?segment=stale&status=DO&only_do=true&limit=500",
        );
        expect(asShipped.status).toBe(200);
        const rows = asShipped.body.rows ?? asShipped.body.items;
        const mine = rows.filter((r) => r.so_line_id.startsWith(`${P}-do-`));
        // Only the DO line survives. A no-op filter here is worse than no filter:
        // it sits directly upstream of the bulk close, and `close-batch` faithfully
        // closes exactly the ids it is handed — including live ones the operator
        // believed had been filtered away.
        expect(mine.map((r) => r.so_line_id)).toEqual([`${P}-do-1`]);
        expect(mine.some((r) => r.status_order === "Waiting")).toBe(false);
      });
    });

    it("REGRESSION (D1 fixed): `min_age_days` filters instead of 500-ing", async () => {
      // `loadCommitments` builds `c.estimate_delivery <= current_date - ${N}`.
      // postgres.js sends N as an untyped parameter, so Postgres resolves
      // `current_date - $1` against `date - date -> integer` rather than
      // `date - integer -> date`, and the comparison becomes `date <= integer`:
      //
      //     operator does not exist: date <= integer   (SQLSTATE 42883)
      //
      // The handler has no try/catch, so the request 500s. `min_age_days` is a
      // ratified AMENDMENT 8 parameter and the shipped PPIC page sends it
      // whenever the operator picks an age tier on the stale segment
      // (`lmQuery()` in apps/server/public/stock-ppic.html), so the age filter is
      // not degraded — it is a blank error state on the module's busiest queue.
      // A cast (`${N}::int`) or an interval is the fix.
      // Owning file: apps/server/src/routes/stock-atp.ts (loadCommitments,
      // the `o.minAgeDays` where-clause).
      // `min_age_days=0`, a blank and a non-numeric value are all discarded
      // before the clause is built, so only a REAL age tier trips it — which is
      // why nothing in the smoke path ever saw this.
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-age-fg`, qty: 10, parts: parts("SEG-AGE") }]);
        await seedLines(tx, [
          { id: `${P}-age-old`, qty_balance: 5, eta: 900, parts: parts("SEG-AGE") },
          { id: `${P}-age-new`, qty_balance: 5, eta: 70, parts: parts("SEG-AGE") },
        ]);
        const loose = await GET<PagedResponse<CommitLine>>("/api/stock/stale-commitments?limit=500");
        expect(loose.body.items.filter((r) => r.so_line_id.startsWith(`${P}-age-`)).length).toBe(2);
        for (const v of ["0", "abc", ""]) {
          const ok = await app.inject({
            method: "GET",
            url: `/api/stock/stale-commitments?min_age_days=${v}&limit=500`,
          });
          expect(ok.statusCode, v).toBe(200);
        }
      });

      // The clause needs an explicit ::int cast. Without it postgres.js sends the
      // parameter untyped, Postgres resolves `current_date - $1` as date - date ->
      // integer, and the comparison becomes `date <= integer` (42883) — a blank
      // 500 on the busiest queue in the module. Assert it FILTERS, not merely
      // that it stopped erroring.
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-age-fg`, qty: 10, parts: parts("SEG-AGE") }]);
        await seedLines(tx, [
          { id: `${P}-age-old`, qty_balance: 5, eta: 900, parts: parts("SEG-AGE") },
          { id: `${P}-age-mid`, qty_balance: 5, eta: 100, parts: parts("SEG-AGE") },
        ]);
        const res = await app.inject({
          method: "GET",
          url: "/api/stock/stale-commitments?min_age_days=365&limit=500",
        });
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as PagedResponse<CommitLine>;
        const mine = (body.rows ?? body.items).filter((r) => r.so_line_id.startsWith(`${P}-age-`));
        expect(mine.map((r) => r.so_line_id)).toEqual([`${P}-age-old`]);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 3 · the §4.1 state ladder, as corrected by AMENDMENT 10
  //
  // `perlu_produksi` is evaluated FIRST. A SKU with no stock and 120 lembar of
  // demand is an absence somebody has already ordered against, not an empty
  // shelf — and that distinction is the whole reason negative ATP is surfaced.
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /summary — the `state` ladder (§4.1 · AMENDMENT 10)", () => {
    /** Build one SKU with the given shape and read its item back off /summary. */
    async function stateOf(
      tx: Tx,
      tag: string,
      shape: { onHand?: number; committed?: number; adjustment?: number },
    ): Promise<SkuItem> {
      const pa = parts(tag);
      const key = canonicalSkuKey(pa);
      if (shape.onHand !== undefined) {
        await seedFg(tx, [{ sn_fg: `${P}-lad-${tag}`, qty: shape.onHand, parts: pa }]);
      }
      if (shape.committed) {
        await seedLines(tx, [{ id: `${P}-lad-${tag}`, qty_balance: shape.committed, eta: 5, parts: pa }]);
      }
      if (shape.adjustment) await seedAdjustment(tx, key, shape.adjustment);
      const item = await summaryItem(key);
      expect(item, `no /summary item for ${key}`).toBeDefined();
      return item!;
    }

    it("perlu_produksi outranks kosong: on_hand 0 with committed 120 reads perlu_produksi", async () => {
      await inRollback(async (tx) => {
        const it = await stateOf(tx, "LAD1", { onHand: 0, committed: 120 });
        expect(it.on_hand).toBe(0);
        expect(it.committed).toBe(120);
        expect(it.atp).toBe(-120);
        // The pre-AMENDMENT-10 ordering would have said "kosong" here and hidden
        // the demand signal in the one case where it is most urgent.
        expect(it.state).toBe("perlu_produksi");
        expect(it.state).not.toBe("kosong");
      });
    });

    it("perlu_produksi outranks habis: stock on hand but ATP negative", async () => {
      await inRollback(async (tx) => {
        const it = await stateOf(tx, "LAD2", { onHand: 10, committed: 30 });
        expect(it.atp).toBe(-20);
        expect(it.state).toBe("perlu_produksi");
      });
    });

    it("kosong is only an absence nobody is waiting on", async () => {
      await inRollback(async (tx) => {
        const it = await stateOf(tx, "LAD3", { onHand: 0 });
        expect(it.on_hand).toBe(0);
        expect(it.committed).toBe(0);
        expect(it.atp).toBe(0);
        expect(it.state).toBe("kosong");
      });
    });

    it("a negative adjustment can drive a SKU to kosong", async () => {
      await inRollback(async (tx) => {
        const it = await stateOf(tx, "LAD4", { onHand: 5, adjustment: -5 });
        expect(it.on_hand).toBe(5);
        expect(it.adjustment).toBe(-5);
        expect(it.atp).toBe(0);
        expect(it.state).toBe("kosong"); // on_hand + adjustment <= 0
      });
    });

    it("habis is ATP exactly 0 with physical stock present", async () => {
      await inRollback(async (tx) => {
        const it = await stateOf(tx, "LAD5", { onHand: 50, committed: 50 });
        expect(it.atp).toBe(0);
        expect(it.on_hand).toBe(50);
        expect(it.state).toBe("habis");
      });
    });

    it("tersedia is ATP strictly above 0", async () => {
      await inRollback(async (tx) => {
        const it = await stateOf(tx, "LAD6", { onHand: 50, committed: 10 });
        expect(it.atp).toBe(40);
        expect(it.state).toBe("tersedia");
      });
    });

    it("the tersedia/habis boundary is exact at ATP 1 and ATP 0", async () => {
      await inRollback(async (tx) => {
        const one = await stateOf(tx, "LAD7", { onHand: 50, committed: 49 });
        expect(one.atp).toBe(1);
        expect(one.state).toBe("tersedia");
        const zero = await stateOf(tx, "LAD8", { onHand: 50, committed: 50 });
        expect(zero.atp).toBe(0);
        expect(zero.state).toBe("habis");
      });
    });

    it("the habis/perlu_produksi boundary is exact at ATP 0 and ATP −1", async () => {
      await inRollback(async (tx) => {
        const zero = await stateOf(tx, "LAD9", { onHand: 50, committed: 50 });
        expect(zero.state).toBe("habis");
        const minus = await stateOf(tx, "LADA", { onHand: 50, committed: 51 });
        expect(minus.atp).toBe(-1);
        expect(minus.state).toBe("perlu_produksi");
      });
    });

    it("stale commitments never move the state — they are context, not a subtraction", async () => {
      await inRollback(async (tx) => {
        const pa = parts("LADB");
        const key = canonicalSkuKey(pa);
        await seedFg(tx, [{ sn_fg: `${P}-lad-ladb`, qty: 100, parts: pa }]);
        await seedLines(tx, [
          { id: `${P}-ladb-live`, qty_balance: 10, eta: 5, parts: pa },
          { id: `${P}-ladb-stale`, qty_balance: 5000, eta: 400, parts: pa },
        ]);
        const it = (await summaryItem(key))!;
        expect(it.committed).toBe(10);
        expect(it.stale_committed).toBe(5000);
        expect(it.atp).toBe(90); // NOT 100 − 5010
        expect(it.state).toBe("tersedia");
      });
    });

    it("REGRESSION (AMENDMENT 13 ratified): the §4.1 ladder is total — ATP 0 with a positive opname is habis", async () => {
      // on_hand 0, adjustment +5, committed 5 ⇒ atp 0. Under the AMENDMENT 10
      // ladder this matched no row at all:
      //   1 perlu_produksi  atp < 0                     → no
      //   2 kosong          on_hand + adjustment <= 0   → no (it is +5)
      //   3 habis           atp <= 0 AND on_hand > 0    → no (on_hand is 0)
      //   4 tersedia        atp > 0                     → no
      // This test was first filed as an open finding against the contract: the
      // implementation fell through to a `habis` default that appeared nowhere
      // in CONTRACTS, so a re-implementation could legitimately have chosen
      // `kosong` instead and broken the page with nothing to stop it.
      //
      // AMENDMENT 13 ratified `habis` and made the ladder total: row 3 now tests
      // EFFECTIVE on-hand (an opname adjustment is physical truth), and row 4 is
      // a bare `otherwise`. So the assertion below is no longer a documented
      // defect — it is the contract, and this test is the guard that keeps it.
      // Reachable the moment PPIC books a positive opname against a fully
      // committed SKU with no mirror row.
      await inRollback(async (tx) => {
        const it = await stateOf(tx, "LADC", { onHand: 0, committed: 5, adjustment: 5 });
        expect(it.on_hand).toBe(0);
        expect(it.adjustment).toBe(5);
        expect(it.atp).toBe(0);
        expect(it.state).toBe("habis"); // AMENDMENT 13 row 3, on effective on-hand
      });
    });

    it("totals are self-consistent with items[] — the ladder is counted once", async () => {
      await inRollback(async (tx) => {
        await seedWarna(tx);
        await stateOf(tx, "LADD", { onHand: 0, committed: 120 });
        await stateOf(tx, "LADE", { onHand: 50, committed: 10 });
        await stateOf(tx, "LADF", { onHand: 50, committed: 50 });
        await stateOf(tx, "LADG", { onHand: 0 });

        const { body } = await GET<SummaryResponse>("/api/stock/summary");
        expect(body.totals.skus).toBe(body.items.length);
        for (const state of ["tersedia", "habis", "kosong", "perlu_produksi"] as const) {
          expect(body.totals[state]).toBe(body.items.filter((i) => i.state === state).length);
        }
        // Every item carries the full §4.1 shape, including the display-only m².
        const one = body.items.find((i) => i.sku_key === keyOf("LADE"))!;
        expect(Object.keys(one).sort()).toEqual(
          [
            "adjustment", "atp", "atp_m2", "brand", "brand_text", "committed", "kode_barang", "l",
            "name", "nearest_eta", "on_hand", "p", "sku_key", "stale_committed", "state", "th",
            "th_panel", "unit", "warna", "warna_name",
          ].sort(),
        );
        expect(one.unit).toBe("lembar");
        // brand · colour · panel · skin · dimensions. FIX 7: the colour is an ID
        // on both mirrored tables, and the name comes from the mirrored master —
        // an operator must read "HITAM GALAKSI QA", never "907001".
        expect(one.name).toBe(`WP7RT-LADE ${WARNA_NAME} 4 0.3 · 4880×1220`);
        expect(one.warna).toBe(WARNA_CODE);
        expect(one.warna_name).toBe(WARNA_NAME);
        // Nominal panel area fallback: 4880 × 1220 mm² = 5.9536 m² per lembar.
        expect(one.atp_m2).toBe(238.14);
        expect(body.freshness.erp_connected).toBe(false);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 4 · the retirement surface (ST-R14 / ST-R15, CONTRACTS §4.3)
  //
  // A 410 that quietly became a 404 looks fine in a smoke test and breaks the
  // page: the client cannot tell "retired" from "you typed the URL wrong".
  // ═══════════════════════════════════════════════════════════════════════════

  describe("retired + archived 1.0 surface (§4.3)", () => {
    const GONE = "Booking sudah tidak digunakan. Stok kini mengikuti Sales Order dari ERP.";
    const RETIRED_POSTS = [
      "/api/stock/bookings",
      "/api/stock/bookings/123/verify",
      "/api/stock/bookings/123/cancel",
      "/api/stock/bookings/123/complete",
      "/api/stock/bookings/123/fulfill",
      "/api/stock/uploads",
    ];

    it("all six retired POSTs return 410 with exactly the frozen Bahasa body", async () => {
      expect(RETIRED_POSTS.length).toBe(6);
      for (const url of RETIRED_POSTS) {
        const res = await app.inject({ method: "POST", url, payload: { anything: true } });
        expect(res.statusCode, `${url} status`).toBe(410);
        // Exactly this object — not a superset, not a 404, not a 405.
        expect(res.json(), `${url} body`).toEqual({ error: GONE });
      }
    });

    it("the 410 is unconditional — it does not depend on a database", async () => {
      // No transaction is opened here: the tombstones answer before any handler
      // touches getSql(), which is what makes them safe during a rollback (L0b).
      const res = await app.inject({ method: "POST", url: "/api/stock/bookings", payload: {} });
      expect(res.statusCode).toBe(410);
      expect(res.json()).toEqual({ error: GONE });
    });

    it("all five archive GETs still return 200 (ST-R14)", async () => {
      await inRollback(async (tx) => {
        // Frozen history to read. `archived` avoids the one-active partial index.
        const [up] = await tx`
          insert into stock_uploads (filename, sheet_name, uploaded_by, note, status, row_count, archived_at)
          values (${`${P}.xlsx`}, 'Sheet1', ${ACTOR}, 'arsip qa', 'archived', 1, now())
          returning id
        `;
        const uploadId = String((up as { id: string }).id);
        const [item] = await tx`
          insert into stock_items (upload_id, name, product_line, unit, qty_initial, sort_order)
          values (${uploadId}, ${`${P} panel`}, 'ACP', 'lembar', 100, 1)
          returning id
        `;
        const itemId = String((item as { id: string }).id);

        for (const url of [
          "/api/stock/uploads?limit=5",
          `/api/stock/uploads/${uploadId}`,
          "/api/stock/bookings",
          `/api/stock/items/${itemId}/riwayat`,
          "/api/stock/rep-stats",
        ]) {
          const res = await app.inject({ method: "GET", url });
          expect(res.statusCode, `${url} status`).toBe(200);
          expect(res.json(), `${url} body`).toBeTruthy();
        }

        // The archived period really is readable, not merely 200-with-nothing.
        const { body } = await GET<{ upload: { id: string }; items: { name: string }[] }>(
          `/api/stock/uploads/${uploadId}`,
        );
        expect(String(body.upload.id)).toBe(uploadId);
        expect(body.items.map((i) => i.name)).toContain(`${P} panel`);
      });
    });

    it("GET /summary is served by the ATP module, not the archive (ST-R15)", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-r15-fg`, qty: 7, parts: parts("R15") }]);
        const { status, body } = await GET<SummaryResponse>("/api/stock/summary");
        expect(status).toBe(200);
        // The 1.0 body had `uploads`/`items[].available`; this one is ATP-shaped.
        expect(body.freshness).toBeDefined();
        expect(body.totals).toBeDefined();
        expect(body.items.find((i) => i.sku_key === keyOf("R15"))!.atp).toBe(7);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 5 · atp_delta on close and reinstate (AMENDMENT 6a)
  //
  // The asymmetry IS the safety property. Closing a stale line moves ATP by 0;
  // closing an undated line releases its whole balance. An operator trained by
  // the first case silently releases stock in the second, so both are asserted.
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /stale-commitments/:id/close and /reinstate (AMENDMENT 6a)", () => {
    const S = parts("D-STALE");
    const U = parts("D-UNDATED");
    const KS = canonicalSkuKey(S);
    const KU = canonicalSkuKey(U);

    async function seedDelta(tx: Tx): Promise<void> {
      await seedFg(tx, [
        { sn_fg: `${P}-d-fg-s`, qty: 200, parts: S },
        { sn_fg: `${P}-d-fg-u`, qty: 200, parts: U },
      ]);
      await seedLines(tx, [
        { id: `${P}-d-stale`, qty_balance: 75, eta: 400, parts: S },
        { id: `${P}-d-undated`, qty_balance: 120, eta: null, parts: U },
      ]);
    }

    it("closing a STALE line reports atp_delta 0 — it was already excluded", async () => {
      await inRollback(async (tx) => {
        await seedDelta(tx);
        const { status, body } = await POST<OverrideResponse>(
          `/api/stock/stale-commitments/${P}-d-stale/close`,
          { actor: ACTOR, reason: "phantom 2020" },
        );
        expect(status).toBe(200);
        expect(body.ok).toBe(true);
        expect(body.so_line_id).toBe(`${P}-d-stale`);
        expect(body.sku_key).toBe(KS);

        expect(body.atp_delta).toBe(0);
        expect(body.atp_before).toBe(200);
        expect(body.atp_after).toBe(200);
        // atp_before/atp_after bracket the delta — the three numbers agree.
        expect(body.atp_after - body.atp_before).toBe(body.atp_delta);
        // …and they agree with what /summary independently reports.
        expect(await atpOf(KS)).toBe(body.atp_after);

        expect(body.override.state).toBe("closed");
        expect(body.override.actor).toBe(ACTOR);
        expect(body.commitment!.state).toBe("closed");
        expect((await overrideRows(tx)).map((r) => r.so_line_id)).toEqual([`${P}-d-stale`]);
      });
    });

    it("closing an UNDATED line releases its whole balance — the opposite consequence", async () => {
      await inRollback(async (tx) => {
        await seedDelta(tx);
        const { status, body } = await POST<OverrideResponse>(
          `/api/stock/stale-commitments/${P}-d-undated/close`,
          { actor: ACTOR, reason: "pesanan batal" },
        );
        expect(status).toBe(200);
        expect(body.atp_before).toBe(80); // 200 on hand − 120 reserved
        expect(body.atp_delta).toBe(120); // the entire balance goes back
        expect(body.atp_after).toBe(200);
        expect(body.atp_after - body.atp_before).toBe(body.atp_delta);
        expect(await atpOf(KU)).toBe(200);
      });
    });

    it("the two populations differ by exactly the balance — the AMENDMENT 6 table, asserted", async () => {
      await inRollback(async (tx) => {
        await seedDelta(tx);
        const stale = await POST<OverrideResponse>(`/api/stock/stale-commitments/${P}-d-stale/close`, {
          actor: ACTOR,
          reason: "phantom 2020",
        });
        const undated = await POST<OverrideResponse>(`/api/stock/stale-commitments/${P}-d-undated/close`, {
          actor: ACTOR,
          reason: "pesanan batal",
        });
        expect(stale.body.atp_delta).toBe(0);
        expect(undated.body.atp_delta).toBe(120);
        expect(undated.body.atp_delta).not.toBe(stale.body.atp_delta);
      });
    });

    it("reinstating an undated line re-reserves the stock and reports a negative delta", async () => {
      await inRollback(async (tx) => {
        await seedDelta(tx);
        await POST(`/api/stock/stale-commitments/${P}-d-undated/close`, { actor: ACTOR, reason: "pesanan batal" });
        const { status, body } = await POST<OverrideResponse>(
          `/api/stock/stale-commitments/${P}-d-undated/reinstate`,
          { actor: ACTOR },
        );
        expect(status).toBe(200);
        expect(body.atp_before).toBe(200);
        expect(body.atp_delta).toBe(-120);
        expect(body.atp_after).toBe(80);
        expect(body.atp_after - body.atp_before).toBe(body.atp_delta);
        // The line goes back to being whatever the liveness rule says it is.
        expect(body.commitment!.state).toBe("live");
        expect(body.commitment!.undated).toBe(true);
        expect(body.override.state).toBe("reinstated");
      });
    });

    it("reinstating a stale line reports 0 and returns it to the stale queue", async () => {
      await inRollback(async (tx) => {
        await seedDelta(tx);
        await POST(`/api/stock/stale-commitments/${P}-d-stale/close`, { actor: ACTOR, reason: "phantom 2020" });
        const { body } = await POST<OverrideResponse>(`/api/stock/stale-commitments/${P}-d-stale/reinstate`, {
          actor: ACTOR,
        });
        expect(body.atp_delta).toBe(0);
        expect(body.commitment!.state).toBe("stale");
      });
    });

    it("close → reinstate → close returns ATP to where each step said it would", async () => {
      await inRollback(async (tx) => {
        await seedDelta(tx);
        const start = await atpOf(KU);
        const a = await POST<OverrideResponse>(`/api/stock/stale-commitments/${P}-d-undated/close`, {
          actor: ACTOR,
          reason: "pesanan batal",
        });
        const b = await POST<OverrideResponse>(`/api/stock/stale-commitments/${P}-d-undated/reinstate`, {
          actor: ACTOR,
        });
        const c = await POST<OverrideResponse>(`/api/stock/stale-commitments/${P}-d-undated/close`, {
          actor: ACTOR,
          reason: "pesanan batal lagi",
        });
        expect(a.body.atp_delta + b.body.atp_delta + c.body.atp_delta).toBe(120);
        expect(await atpOf(KU)).toBe(start + 120);
        // One override row throughout — it is updated, never duplicated.
        expect((await overrideRows(tx)).length).toBe(1);
      });
    });

    it("an unknown so_line_id is 404 and writes nothing", async () => {
      await inRollback(async (tx) => {
        await seedDelta(tx);
        const { status, body } = await POST<{ error: string }>(
          `/api/stock/stale-commitments/${P}-nope/close`,
          { actor: ACTOR, reason: "phantom" },
        );
        expect(status).toBe(404);
        expect(body.error).toBe("Baris Sales Order tidak ditemukan.");
        expect(await overrideRows(tx)).toEqual([]);
      });
    });

    it("a missing actor is rejected — every write records one (§7.8)", async () => {
      await inRollback(async (tx) => {
        await seedDelta(tx);
        for (const url of [
          `/api/stock/stale-commitments/${P}-d-stale/close`,
          `/api/stock/stale-commitments/${P}-d-stale/reinstate`,
        ]) {
          const { status, body } = await POST<{ error: string }>(url, { reason: "phantom" });
          expect(status).toBe(400);
          expect(body.error).toBe("Nama petugas wajib diisi.");
        }
        expect(await overrideRows(tx)).toEqual([]);
      });
    });

    it("closing does not write the mirror (§7.2)", async () => {
      await inRollback(async (tx) => {
        await seedDelta(tx);
        const before = await mirrorDigest(tx);
        await POST(`/api/stock/stale-commitments/${P}-d-undated/close`, { actor: ACTOR, reason: "pesanan batal" });
        expect(await mirrorDigest(tx)).toEqual(before);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 6 · the list envelope (AMENDMENT 8) and server-side ranking (AMENDMENT 9)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("list envelope on all four lists (AMENDMENT 8)", () => {
    const LISTS = [
      "/api/stock/shortfall",
      "/api/stock/exceptions",
      "/api/stock/adjustments",
      "/api/stock/stale-commitments",
    ] as const;

    it("every list answers with page, limit, total, has_more and a row array", async () => {
      await inRollback(async () => {
        for (const url of LISTS) {
          const { status, body } = await GET<PagedResponse<unknown>>(`${url}?page=1&limit=5`);
          expect(status, url).toBe(200);
          expect(body.page, url).toBe(1);
          expect(body.limit, url).toBe(5);
          expect(typeof body.total, url).toBe("number");
          expect(typeof body.has_more, url).toBe("boolean");
          expect(Array.isArray(body.items), url).toBe(true);
          expect(body.items.length, url).toBeLessThanOrEqual(5);
        }
      });
    });

    it("REGRESSION (D4 fixed): the ratified envelope ships `rows` and `grand_total`", async () => {
      // AMENDMENT 8 ratified `{ rows, total, grand_total, status_facets }` as
      // final, precisely because two front-end packages had each invented their
      // own spelling. The routes ship `items` and omit both extra counts, so the
      // PPIC page falls back exactly as the amendment predicted: the count line
      // degrades and the status filter can only honestly say "this page only".
      // The shipped page reads through alias-tolerant helpers, so this degrades
      // rather than breaks — which is why it survived to here unnoticed.
      // Owning file: apps/server/src/routes/stock-atp.ts (PagedResponse + all
      // four list handlers).
      await inRollback(async () => {
        for (const url of LISTS) {
          const { body } = await GET<Record<string, unknown>>(`${url}?limit=5`);
          expect(Object.keys(body), url).toContain("rows");
          expect(Object.keys(body), url).toContain("grand_total");
          // `items` is kept as a byte-identical duplicate so both shipped pages
          // and the existing assertions keep working.
          expect(body.items, url).toEqual(body.rows);
        }
        const { body } = await GET<Record<string, unknown>>("/api/stock/stale-commitments?limit=5");
        expect(Object.keys(body)).toContain("status_facets");
      });
    });

    it("limit is capped server-side — a client may not request 4,000 rows", async () => {
      await inRollback(async () => {
        for (const url of LISTS) {
          const { body } = await GET<PagedResponse<unknown>>(`${url}?limit=4000`);
          expect(body.limit, url).toBe(500);
          expect(body.items.length, url).toBeLessThanOrEqual(500);
        }
        // Nonsense values fall back to the default rather than 500ing.
        for (const bad of ["0", "-5", "abc", ""]) {
          const { status, body } = await GET<PagedResponse<unknown>>(`/api/stock/stale-commitments?limit=${bad}`);
          expect(status, bad).toBe(200);
          expect(body.limit, bad).toBeGreaterThanOrEqual(1);
          expect(body.limit, bad).toBeLessThanOrEqual(500);
        }
      });
    });

    it("page and has_more walk a real result set without dropping or repeating a row", async () => {
      await inRollback(async (tx) => {
        const pa = parts("PAGE");
        await seedFg(tx, [{ sn_fg: `${P}-pg-fg`, qty: 10, parts: pa }]);
        await seedLines(tx, [
          { id: `${P}-pg-1`, qty_balance: 1, eta: 100, parts: pa },
          { id: `${P}-pg-2`, qty_balance: 2, eta: 200, parts: pa },
          { id: `${P}-pg-3`, qty_balance: 3, eta: 300, parts: pa },
        ]);
        const q = `/api/stock/stale-commitments?sku_key=${encodeURIComponent(canonicalSkuKey(pa))}&sort=eta_asc`;

        const all = await GET<PagedResponse<CommitLine>>(`${q}&limit=50`);
        expect(all.body.total).toBe(3);
        expect(all.body.has_more).toBe(false);

        const p1 = await GET<PagedResponse<CommitLine>>(`${q}&page=1&limit=2`);
        expect(p1.body.total).toBe(3);
        expect(p1.body.items.length).toBe(2);
        expect(p1.body.has_more).toBe(true);

        const p2 = await GET<PagedResponse<CommitLine>>(`${q}&page=2&limit=2`);
        expect(p2.body.total).toBe(3);
        expect(p2.body.items.length).toBe(1);
        expect(p2.body.has_more).toBe(false);

        const seen = [...p1.body.items, ...p2.body.items].map((r) => r.so_line_id);
        expect(seen).toEqual([`${P}-pg-3`, `${P}-pg-2`, `${P}-pg-1`]); // oldest ETA first
        expect(new Set(seen).size).toBe(3);
      });
    });

    it("`total` counts the filtered set, not the page", async () => {
      await inRollback(async (tx) => {
        const pa = parts("TOT");
        await seedFg(tx, [{ sn_fg: `${P}-tot-fg`, qty: 10, parts: pa }]);
        await seedLines(tx, [
          { id: `${P}-tot-1`, qty_balance: 1, eta: 100, parts: pa, customer: "PT Alpha QA" },
          { id: `${P}-tot-2`, qty_balance: 1, eta: 200, parts: pa, customer: "PT Alpha QA", so_id: `${P}-so-a` },
          { id: `${P}-tot-3`, qty_balance: 1, eta: 300, parts: pa, customer: "PT Beta QA", so_id: `${P}-so-b` },
        ]);
        const key = encodeURIComponent(canonicalSkuKey(pa));
        const unfiltered = await GET<PagedResponse<CommitLine>>(
          `/api/stock/stale-commitments?sku_key=${key}&limit=1`,
        );
        expect(unfiltered.body.total).toBe(3);
        expect(unfiltered.body.items.length).toBe(1);

        const filtered = await GET<PagedResponse<CommitLine>>(
          `/api/stock/stale-commitments?sku_key=${key}&q=Beta%20QA&limit=50`,
        );
        expect(filtered.body.total).toBe(1);
        expect(filtered.body.items.map((r) => r.so_line_id)).toEqual([`${P}-tot-3`]);
      });
    });

    it("`q` searches the fields AMENDMENT 8 names, and escapes LIKE wildcards", async () => {
      await inRollback(async (tx) => {
        const pa = parts("QFIND");
        await seedFg(tx, [{ sn_fg: `${P}-q-fg`, qty: 10, parts: pa }]);
        await seedLines(tx, [
          { id: `${P}-q-1`, qty_balance: 1, eta: 100, parts: pa, so_id: `${P}-so-q1`, customer: "PT Cahaya QA" },
          { id: `${P}-q-2`, qty_balance: 1, eta: 100, parts: pa, so_id: `${P}-so-q2`, customer: "PT Damai QA" },
        ]);
        const base = `/api/stock/stale-commitments?sku_key=${encodeURIComponent(canonicalSkuKey(pa))}&limit=50`;

        const byCustomer = await GET<PagedResponse<CommitLine>>(`${base}&q=Cahaya`);
        expect(byCustomer.body.items.map((r) => r.so_line_id)).toEqual([`${P}-q-1`]);

        const bySo = await GET<PagedResponse<CommitLine>>(`${base}&q=${encodeURIComponent(`SO-${P}-so-q2`)}`);
        expect(bySo.body.items.map((r) => r.so_line_id)).toEqual([`${P}-q-2`]);

        const byKode = await GET<PagedResponse<CommitLine>>(`${base}&q=WP7RT-QFIND`);
        expect(byKode.body.items.length).toBe(2);

        // A bare `%` must not become "match everything".
        const wildcard = await GET<PagedResponse<CommitLine>>(`${base}&q=%25`);
        expect(wildcard.status).toBe(200);
        expect(wildcard.body.items.length).toBe(0);
      });
    });

    it("`q` on /adjustments matches sku_key, actor and reason", async () => {
      await inRollback(async (tx) => {
        const key = keyOf("ADJQ");
        await tx`
          insert into stock_adjustments (sku_key, qty_delta, reason, actor)
          values (${key}, 5, ${'selisih opname gudang'}, ${ACTOR})
        `;
        for (const q of [encodeURIComponent(key), encodeURIComponent(ACTOR), "opname%20gudang"]) {
          const { body } = await GET<PagedResponse<AdjustmentRow>>(`/api/stock/adjustments?limit=50&q=${q}`);
          expect(body.items.some((r) => r.sku_key === key), q).toBe(true);
        }
        const miss = await GET<PagedResponse<AdjustmentRow>>("/api/stock/adjustments?limit=50&q=zzzz-no-such-thing");
        expect(miss.body.items.length).toBe(0);
        expect(miss.body.total).toBe(0);
      });
    });

    it("/shortfall arrives ranked: deficit desc, then nearest ETA asc (AMENDMENT 9)", async () => {
      await inRollback(async (tx) => {
        // Three deficits: 100/far, 100/near, 50/nearest. The correct production
        // order puts the two big deficits first, the nearer deadline ahead.
        const far = parts("SF-BIGFAR");
        const near = parts("SF-BIGNEAR");
        const small = parts("SF-SMALL");
        await seedFg(tx, [
          { sn_fg: `${P}-sf-1`, qty: 10, parts: far },
          { sn_fg: `${P}-sf-2`, qty: 10, parts: near },
          { sn_fg: `${P}-sf-3`, qty: 10, parts: small },
        ]);
        await seedLines(tx, [
          { id: `${P}-sf-far`, qty_balance: 110, eta: -50, parts: far },
          { id: `${P}-sf-near`, qty_balance: 110, eta: -5, parts: near },
          { id: `${P}-sf-small`, qty_balance: 60, eta: -1, parts: small },
        ]);

        const { status, body } = await GET<PagedResponse<SkuItem & { deficit: number; lines: number }>>(
          "/api/stock/shortfall?limit=500",
        );
        expect(status).toBe(200);
        const mine = body.items.filter((i) => i.sku_key.startsWith("WP7RT-SF-"));
        expect(mine.map((i) => i.sku_key)).toEqual([
          canonicalSkuKey(near),
          canonicalSkuKey(far),
          canonicalSkuKey(small),
        ]);
        expect(mine.map((i) => i.deficit)).toEqual([100, 100, 50]);
        expect(mine[0]!.nearest_eta! < mine[1]!.nearest_eta!).toBe(true);
        expect(mine.every((i) => i.lines === 1)).toBe(true);
        // A shortfall row is negative ATP, never clamped (§7.5).
        expect(mine.map((i) => i.atp)).toEqual([-100, -100, -50]);
      });
    });

    it("/shortfall lists only SKUs whose live demand exceeds stock", async () => {
      await inRollback(async (tx) => {
        const ok = parts("SF-OK");
        await seedFg(tx, [{ sn_fg: `${P}-sfok-fg`, qty: 100, parts: ok }]);
        await seedLines(tx, [
          { id: `${P}-sfok-live`, qty_balance: 10, eta: 5, parts: ok },
          // A stale line of 5,000 must NOT drag the SKU into the queue: it is
          // quarantined, not demand anyone is waiting on.
          { id: `${P}-sfok-stale`, qty_balance: 5000, eta: 400, parts: ok },
        ]);
        const { body } = await GET<PagedResponse<SkuItem>>("/api/stock/shortfall?limit=500");
        expect(body.items.map((i) => i.sku_key)).not.toContain(canonicalSkuKey(ok));
      });
    });

    it("/shortfall honours `q` and still returns the ranked slice", async () => {
      await inRollback(async (tx) => {
        const a = parts("SF-QA");
        const b = parts("SF-QB");
        await seedFg(tx, [
          { sn_fg: `${P}-sfq-1`, qty: 1, parts: a },
          { sn_fg: `${P}-sfq-2`, qty: 1, parts: b },
        ]);
        await seedLines(tx, [
          { id: `${P}-sfq-a`, qty_balance: 20, eta: -5, parts: a },
          { id: `${P}-sfq-b`, qty_balance: 30, eta: -5, parts: b },
        ]);
        const { body } = await GET<PagedResponse<SkuItem>>("/api/stock/shortfall?limit=500&q=WP7RT-SF-QB");
        expect(body.items.map((i) => i.sku_key)).toEqual([canonicalSkuKey(b)]);
        expect(body.total).toBe(1);
      });
    });

    it("/exceptions lists approved demand with no FG row, tagged sku_tidak_cocok (ST-R5.3)", async () => {
      await inRollback(async (tx) => {
        const ghost = parts("EXC-GHOST"); // demand, but no erp_live_fg row at all
        const held = parts("EXC-HELD");
        await seedFg(tx, [{ sn_fg: `${P}-exc-fg`, qty: 50, parts: held }]);
        await seedLines(tx, [
          { id: `${P}-exc-ghost`, qty_balance: 12, eta: 5, parts: ghost },
          { id: `${P}-exc-held`, qty_balance: 12, eta: 5, parts: held },
        ]);

        const { status, body } = await GET<PagedResponse<CommitLine & { reason: string }>>(
          "/api/stock/exceptions?limit=500",
        );
        expect(status).toBe(200);
        const mine = body.items.filter((r) => r.so_line_id.startsWith(`${P}-exc-`));
        expect(mine.map((r) => r.so_line_id)).toEqual([`${P}-exc-ghost`]);
        expect(mine[0]!.reason).toBe("sku_tidak_cocok");
        expect(mine[0]!.unmatched).toBe(true);

        // AMENDMENT 2 / §7.6: it is an exception AND it still reserves — the SKU
        // appears in /summary with a negative ATP rather than being dropped.
        const it = await summaryItem(canonicalSkuKey(ghost));
        expect(it).toBeDefined();
        expect(it!.on_hand).toBe(0);
        expect(it!.atp).toBe(-12);
        expect(it!.state).toBe("perlu_produksi");
      });
    });

    it("counts unmatched demand in LINES and in SKUS — only the second is a share (FIX E)", async () => {
      await inRollback(async (tx) => {
        // One unmatched SKU with THREE lines against it, plus one healthy SKU.
        // `exceptions` counts lines and `exception_skus` counts SKUs, and the
        // PPIC alarm divides by `skus` — so comparing the line count against a
        // SKU count overstates the problem (a realistic population measured
        // 512%, which cannot be a share of anything).
        const ghost = parts("EXSK-GHOST");
        const held = parts("EXSK-HELD");
        await seedFg(tx, [{ sn_fg: `${P}-exsk-fg`, qty: 50, parts: held }]);
        await seedLines(tx, [
          { id: `${P}-exsk-g1`, qty_balance: 4, eta: 5, parts: ghost },
          { id: `${P}-exsk-g2`, qty_balance: 4, eta: 6, parts: ghost },
          { id: `${P}-exsk-g3`, qty_balance: 4, eta: 7, parts: ghost },
          { id: `${P}-exsk-h1`, qty_balance: 4, eta: 5, parts: held },
        ]);

        const before = await GET<SummaryResponse>("/api/stock/summary");
        const ghostKey = canonicalSkuKey(ghost);
        const mine = before.body.items.filter((i) => i.sku_key === ghostKey);
        expect(mine).toHaveLength(1);

        // The three lines contribute 3 to `exceptions` and 1 to `exception_skus`.
        const { body } = await GET<SummaryResponse>("/api/stock/summary");
        expect(body.totals.exceptions).toBeGreaterThanOrEqual(3);
        expect(body.totals.exception_skus).toBeGreaterThanOrEqual(1);
        expect(body.totals.exceptions).toBeGreaterThan(body.totals.exception_skus);
        // A count of SKUs can never exceed the number of SKUs — which is exactly
        // the property the line count does not have.
        expect(body.totals.exception_skus).toBeLessThanOrEqual(body.totals.skus);
      });
    });

    it("says the ERP rejected our credentials as a VALUE, not a message to grep (FIX D)", async () => {
      await inRollback(async (tx) => {
        // Healthy first: never having synced is not an authorization verdict, so
        // a fresh deployment must not wear a "call IT" banner.
        const healthy = await GET<SyncStatusResponse>("/api/stock/sync-status");
        expect(healthy.body.freshness.erp_authorized).toBe(true);

        await tx`
          update erp_sync_state
             set last_error = 'HTTP 401 from ERP', last_error_kind = 'auth', last_error_at = now()
           where table_name = 'so_line'
        `;
        const denied = await GET<SyncStatusResponse>("/api/stock/sync-status");
        expect(denied.body.freshness.erp_authorized).toBe(false);
        expect(denied.body.tables.find((t) => t.table_name === "so_line")?.last_error_kind).toBe("auth");
        // …and /summary carries the same flag, since that is the page sales sees.
        const summary = await GET<SummaryResponse>("/api/stock/summary");
        expect(summary.body.freshness.erp_authorized).toBe(false);

        // A network failure is NOT an authorization failure: "wait" is the right
        // advice there, and "call IT" is not.
        await tx`update erp_sync_state set last_error_kind = 'network' where table_name = 'so_line'`;
        const down = await GET<SyncStatusResponse>("/api/stock/sync-status");
        expect(down.body.freshness.erp_authorized).toBe(true);
      });
    });

    it("GET /sync-status carries freshness, the cursors and every mirrored table", async () => {
      await inRollback(async () => {
        const { status, body } = await GET<SyncStatusResponse>("/api/stock/sync-status");
        expect(status).toBe(200);
        // `warna` (the colour master, tbl_1228) joined the mirrored set on
        // 2026-09-11 and is synced exactly like the others.
        expect(body.tables.map((t) => t.table_name).sort()).toEqual([
          "live_fg", "so_header", "so_line", "warna",
        ]);
        // FIX D: the failure KIND is a typed value, not a substring of last_error.
        expect(typeof body.freshness.erp_authorized).toBe("boolean");
        for (const t of body.tables) {
          expect(
            t.last_error_kind === null ||
              ["auth", "network", "shape", "erp_error", "server", "other"].includes(t.last_error_kind),
          ).toBe(true);
        }
        expect(typeof body.interval_ms).toBe("number");
        expect(body.stale_after_ms).toBe(body.interval_ms * 4);
        expect(body.freshness.erp_connected).toBe(false);
        // §7.9: no secret is ever echoed into a response.
        expect(JSON.stringify(body)).not.toMatch(/SELARAS_TOKEN|postgres:\/\//i);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 7 · POST /sync
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /sync", () => {
    it("503 with a Bahasa body when the ERP is not configured", async () => {
      await inRollback(async () => {
        erp.connected = false;
        const { status, body } = await POST<{ error: string }>("/api/stock/sync", { actor: ACTOR });
        expect(status).toBe(503);
        expect(body).toEqual({ error: "ERP tidak terhubung." });
      });
    });

    it("the 503 precedes any worker import — an unconfigured kick reaches nothing", async () => {
      await inRollback(async (tx) => {
        erp.connected = false;
        const before = await tx`select table_name, running from erp_sync_state order by table_name`;
        await POST("/api/stock/sync", { actor: ACTOR });
        const after = await tx`select table_name, running from erp_sync_state order by table_name`;
        expect(after).toEqual(before);
      });
    });

    it("REGRESSION (D3 fixed): an in-flight run answers the ratified 409", async () => {
      // AMENDMENT 8, last line: "`POST /sync` returns 409 when a run is in flight.
      // One signal, not three." The handler instead returns 200 with
      // `{ started: false, running: true }` — the three-signal shape the amendment
      // replaced. A client that checks only the status code cannot tell a kick
      // that started from one that was refused, which is exactly the confusion
      // the single signal was ratified to remove.
      // Owning file: apps/server/src/routes/stock-atp.ts (POST /api/stock/sync).
      await inRollback(async (tx) => {
        erp.connected = true;
        try {
          await tx`update erp_sync_state set running = true where table_name = 'so_line'`;
          const { status, body } = await POST<{ started: boolean; running: boolean }>("/api/stock/sync", {
            actor: ACTOR,
          });
          // One signal, not three: the status code alone now distinguishes a kick
          // that started from one that was refused.
          expect(status).toBe(409);
          expect(body.started).toBe(false);

          // The guard itself does hold: no run was kicked off.
          const [row] = await tx`select running from erp_sync_state where table_name = 'so_line'`;
          expect((row as { running: boolean }).running).toBe(true);
        } finally {
          erp.connected = false;
        }
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 8 · sku_key in a path segment (AMENDMENT 5)
  // ═══════════════════════════════════════════════════════════════════════════

  describe("GET /sku/:sku_key (AMENDMENT 3 + AMENDMENT 5)", () => {
    it("a key containing `|` and `.` round-trips through encodeURIComponent", async () => {
      await inRollback(async (tx) => {
        const pa = parts("DOT.KEY", { th: 0.3 });
        const key = canonicalSkuKey(pa);
        expect(key).toContain("|");
        expect(key).toContain(".");

        await seedFg(tx, [{ sn_fg: `${P}-dot-fg`, qty: 12, parts: pa }]);
        const { status, body } = await GET<SkuDetailResponse>(`/api/stock/sku/${encodeURIComponent(key)}`);
        expect(status).toBe(200);
        expect(body.item.sku_key).toBe(key); // byte-identical, both directions
        expect(body.item.on_hand).toBe(12);
      });
    });

    it("the handler does not decode a second time — a `%` in the key survives", async () => {
      await inRollback(async (tx) => {
        // Fastify decodes path params once. A second decodeURIComponent would turn
        // this key's `%2F` into `/` and the lookup would miss. Inserted straight
        // into the mirror because the canonical key normaliser strips `%`.
        const key = "WP7RT-PCT%2FX|4|0.3|4|4880|1220";
        await tx`
          insert into erp_live_fg (
            erp_row_id, sn_fg, kode_barang, brand, warna, th, th_panel, p, l, qty, sku_key
          ) values (
            ${`${P}-pct-fg`}, ${`${P}-pct-fg`}, 'WP7RT-PCT', 'WP7RT-PCT', '4', 0.3, 4, 4880, 1220, 9, ${key}
          )
        `;
        const { status, body } = await GET<SkuDetailResponse>(`/api/stock/sku/${encodeURIComponent(key)}`);
        expect(status).toBe(200);
        expect(body.item.sku_key).toBe(key);
        expect(body.item.on_hand).toBe(9);

        // The double-decoded spelling must NOT resolve — proving the single decode.
        const doubled = await app.inject({
          method: "GET",
          url: `/api/stock/sku/${encodeURIComponent("WP7RT-PCT/X|4|0.3|4|4880|1220")}`,
        });
        expect(doubled.statusCode).toBe(404);
      });
    });

    it("a malformed escape is a 400, not a 500 (ROLLOUT §8)", async () => {
      const res = await app.inject({ method: "GET", url: "/api/stock/sku/%zz" });
      expect(res.statusCode).toBe(400);
    });

    it("an unknown key is 404 with a Bahasa message", async () => {
      await inRollback(async () => {
        const { status, body } = await GET<{ error: string }>(
          `/api/stock/sku/${encodeURIComponent("WP7RT-NOPE|000|1|1|1")}`,
        );
        expect(status).toBe(404);
        expect(body.error).toBe("Kode SKU tidak ditemukan.");
      });
    });

    it("returns the AMENDMENT 3 frozen body, with every array present even when empty", async () => {
      await inRollback(async (tx) => {
        const pa = parts("DET");
        const key = canonicalSkuKey(pa);
        await seedFg(tx, [{ sn_fg: `${P}-det-fg`, qty: 100, qty_m2: 595.36, lokasi: "GD-B", parts: pa }]);
        await seedLines(tx, [
          { id: `${P}-det-live`, qty_balance: 30, eta: 5, parts: pa },
          { id: `${P}-det-undated`, qty_balance: 20, eta: null, parts: pa },
          { id: `${P}-det-stale`, qty_balance: 70, eta: 400, parts: pa },
        ]);
        await seedAdjustment(tx, key, -4);

        const { status, body } = await GET<SkuDetailResponse>(`/api/stock/sku/${encodeURIComponent(key)}`);
        expect(status).toBe(200);
        expect(Object.keys(body).sort()).toEqual(
          ["adjustments", "item", "live_commitments", "on_hand_rows", "stale_commitments"].sort(),
        );

        expect(body.item.on_hand).toBe(100);
        expect(body.item.committed).toBe(50); // 30 dated + 20 undated (AMENDMENT 1)
        expect(body.item.adjustment).toBe(-4);
        expect(body.item.atp).toBe(46);
        expect(body.item.stale_committed).toBe(70);

        // Field names are the erp_so_line / erp_so_header column names — no aliases.
        const live = body.live_commitments.map((r) => r.so_line_id).sort();
        expect(live).toEqual([`${P}-det-live`, `${P}-det-undated`].sort());
        const undated = body.live_commitments.find((r) => r.so_line_id === `${P}-det-undated`)!;
        expect(undated.undated).toBe(true);
        expect(undated.estimate_delivery).toBeNull();
        expect(undated.qty_balance).toBe(20);
        expect(undated.customer_name_text).toBe("PT Pelanggan QA");
        expect(undated.sales_name_text).toBe("Rep QA");
        expect(undated.so_number).toBe(`SO-${P}-so`);

        expect(body.stale_commitments.map((r) => r.so_line_id)).toEqual([`${P}-det-stale`]);
        expect(body.adjustments.map((a) => a.qty_delta)).toEqual([-4]);
        expect(body.adjustments[0]!.actor).toBe(ACTOR);
        expect(body.on_hand_rows.map((r) => r.sn_fg)).toEqual([`${P}-det-fg`]);
        expect(body.on_hand_rows[0]!.lokasi).toBe("GD-B");
        expect(body.on_hand_rows[0]!.qty_m2).toBe(595.36);
      });
    });

    it("arrays are [] and never null for a SKU with stock and nothing else", async () => {
      await inRollback(async (tx) => {
        const pa = parts("BARE");
        await seedFg(tx, [{ sn_fg: `${P}-bare-fg`, qty: 3, parts: pa }]);
        const { body } = await GET<SkuDetailResponse>(
          `/api/stock/sku/${encodeURIComponent(canonicalSkuKey(pa))}`,
        );
        expect(body.live_commitments).toEqual([]);
        expect(body.stale_commitments).toEqual([]);
        expect(body.adjustments).toEqual([]);
        expect(body.on_hand_rows.length).toBe(1);
        expect(body.item).toBeDefined();
      });
    });

    it("a confirm-closed line appears in neither commitment array", async () => {
      await inRollback(async (tx) => {
        const pa = parts("DETC");
        const key = canonicalSkuKey(pa);
        await seedFg(tx, [{ sn_fg: `${P}-detc-fg`, qty: 40, parts: pa }]);
        await seedLines(tx, [{ id: `${P}-detc-stale`, qty_balance: 9, eta: 400, parts: pa }]);
        await POST(`/api/stock/stale-commitments/${P}-detc-stale/close`, { actor: ACTOR, reason: "phantom lama" });
        const { body } = await GET<SkuDetailResponse>(`/api/stock/sku/${encodeURIComponent(key)}`);
        expect(body.live_commitments).toEqual([]);
        expect(body.stale_commitments).toEqual([]);
        expect(body.item.stale_committed).toBe(0);
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 9 · validation and error shapes
  // ═══════════════════════════════════════════════════════════════════════════

  describe("POST /adjustments — ST-R12 validation (§4.2)", () => {
    const KEY = keyOf("ADJ");

    it("a missing reason is rejected and nothing is written", async () => {
      await inRollback(async (tx) => {
        const { status, body } = await POST<{ error: string }>("/api/stock/adjustments", {
          sku_key: KEY,
          qty_delta: -12,
          actor: ACTOR,
        });
        expect(status).toBe(400);
        expect(body).toEqual({ error: "Alasan wajib diisi." });
        expect(await adjustmentCount(tx)).toBe(0);
      });
    });

    it("a reason shorter than 4 characters is rejected too", async () => {
      await inRollback(async (tx) => {
        for (const reason of ["", " ", "ok", "opn"]) {
          const { status, body } = await POST<{ error: string }>("/api/stock/adjustments", {
            sku_key: KEY,
            qty_delta: -12,
            reason,
            actor: ACTOR,
          });
          expect(status, reason).toBe(400);
          expect(body.error, reason).toBe("Alasan wajib diisi.");
        }
        expect(await adjustmentCount(tx)).toBe(0);
      });
    });

    it("a zero qty_delta is rejected and nothing is written", async () => {
      await inRollback(async (tx) => {
        for (const qty_delta of [0, "0", -0]) {
          const { status, body } = await POST<{ error: string }>("/api/stock/adjustments", {
            sku_key: KEY,
            qty_delta,
            reason: "opname gudang",
            actor: ACTOR,
          });
          expect(status, String(qty_delta)).toBe(400);
          expect(body, String(qty_delta)).toEqual({ error: "Jumlah penyesuaian tidak boleh nol." });
        }
        expect(await adjustmentCount(tx)).toBe(0);
      });
    });

    it("a missing or non-numeric qty_delta is rejected and nothing is written", async () => {
      await inRollback(async (tx) => {
        for (const qty_delta of [undefined, null, "", "abc", NaN]) {
          const { status, body } = await POST<{ error: string }>("/api/stock/adjustments", {
            sku_key: KEY,
            qty_delta,
            reason: "opname gudang",
            actor: ACTOR,
          });
          expect(status, String(qty_delta)).toBe(400);
          expect(body.error, String(qty_delta)).toBe("Jumlah penyesuaian tidak valid.");
        }
        expect(await adjustmentCount(tx)).toBe(0);
      });
    });

    it("a missing actor is rejected — every write records one (§7.8)", async () => {
      await inRollback(async (tx) => {
        const { status, body } = await POST<{ error: string }>("/api/stock/adjustments", {
          sku_key: KEY,
          qty_delta: -12,
          reason: "opname gudang",
        });
        expect(status).toBe(400);
        expect(body).toEqual({ error: "Nama petugas wajib diisi." });
        expect(await adjustmentCount(tx)).toBe(0);
      });
    });

    it("a missing sku_key is rejected and nothing is written", async () => {
      await inRollback(async (tx) => {
        const { status, body } = await POST<{ error: string }>("/api/stock/adjustments", {
          qty_delta: -12,
          reason: "opname gudang",
          actor: ACTOR,
        });
        expect(status).toBe(400);
        expect(body).toEqual({ error: "Kode SKU wajib diisi." });
        expect(await adjustmentCount(tx)).toBe(0);
      });
    });

    it("a valid adjustment writes one audited row and moves ATP by exactly the delta", async () => {
      await inRollback(async (tx) => {
        const pa = parts("ADJOK");
        const key = canonicalSkuKey(pa);
        await seedWarna(tx);
        await seedFg(tx, [{ sn_fg: `${P}-adj-fg`, qty: 100, parts: pa }]);
        await seedLines(tx, [{ id: `${P}-adj-live`, qty_balance: 30, eta: 5, parts: pa }]);
        const before = await atpOf(key);
        expect(before).toBe(70);

        const { status, body } = await POST<{ adjustment: AdjustmentRow; item: SkuItem }>(
          "/api/stock/adjustments",
          { sku_key: key, qty_delta: -12, reason: "opname gudang selisih", actor: ACTOR },
        );
        expect(status).toBe(201);
        expect(body.adjustment.qty_delta).toBe(-12);
        expect(body.adjustment.reason).toBe("opname gudang selisih");
        expect(body.adjustment.actor).toBe(ACTOR);
        expect(body.adjustment.sku_key).toBe(key);
        expect(body.adjustment.created_at).toBeTruthy();
        // Recomputed, never applied client-side.
        expect(body.item.adjustment).toBe(-12);
        expect(body.item.atp).toBe(58);
        expect(await atpOf(key)).toBe(58);

        // Read the row back: additive and audited, and the mirror is untouched.
        const rows = await tx`
          select sku_key, qty_delta::float8 as qty_delta, reason, actor
          from stock_adjustments where actor = ${ACTOR} order by id
        `;
        expect(rows).toEqual([
          { sku_key: key, qty_delta: -12, reason: "opname gudang selisih", actor: ACTOR },
        ]);

        // It shows up in the audit list.
        const list = await GET<PagedResponse<AdjustmentRow>>(
          `/api/stock/adjustments?limit=50&sku_key=${encodeURIComponent(key)}`,
        );
        expect(list.body.total).toBe(1);
        expect(list.body.items[0]!.qty_delta).toBe(-12);
        expect(list.body.items[0]!.name).toBe(`WP7RT-ADJOK ${WARNA_NAME} 4 0.3 · 4880×1220`);
      });
    });

    it("adjustments are additive — a second one stacks rather than replacing", async () => {
      await inRollback(async (tx) => {
        const pa = parts("ADJADD");
        const key = canonicalSkuKey(pa);
        await seedFg(tx, [{ sn_fg: `${P}-adjadd-fg`, qty: 100, parts: pa }]);
        await POST("/api/stock/adjustments", { sku_key: key, qty_delta: -10, reason: "opname satu", actor: ACTOR });
        await POST("/api/stock/adjustments", { sku_key: key, qty_delta: -5, reason: "opname dua", actor: ACTOR });
        expect(await adjustmentCount(tx)).toBe(2);
        const it = (await summaryItem(key))!;
        expect(it.adjustment).toBe(-15);
        expect(it.atp).toBe(85);
        expect(it.on_hand).toBe(100); // erp_live_fg was never touched (§7.2)
      });
    });

    it("an adjustment against a SKU with no mirror row still records and still counts", async () => {
      await inRollback(async (tx) => {
        const key = keyOf("ADJORPHAN");
        const { status } = await POST("/api/stock/adjustments", {
          sku_key: key,
          qty_delta: 25,
          reason: "stok titipan",
          actor: ACTOR,
        });
        expect(status).toBe(201);
        expect(await adjustmentCount(tx)).toBe(1);
        const it = (await summaryItem(key))!;
        expect(it.on_hand).toBe(0);
        expect(it.adjustment).toBe(25);
        expect(it.atp).toBe(25);
        expect(it.state).toBe("tersedia");
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // 10 · cross-cutting: reads never mutate, and this suite leaks nothing
  // ═══════════════════════════════════════════════════════════════════════════

  describe("read safety and isolation", () => {
    it("no GET on the module mutates the mirror (§7.2)", async () => {
      await inRollback(async (tx) => {
        const pa = parts("RO");
        await seedFg(tx, [{ sn_fg: `${P}-ro-fg`, qty: 42, parts: pa }]);
        await seedLines(tx, [
          { id: `${P}-ro-live`, qty_balance: 5, eta: 5, parts: pa },
          { id: `${P}-ro-stale`, qty_balance: 5, eta: 400, parts: pa },
        ]);
        const before = await mirrorDigest(tx);
        for (const url of [
          "/api/stock/summary",
          `/api/stock/sku/${encodeURIComponent(canonicalSkuKey(pa))}`,
          "/api/stock/shortfall",
          "/api/stock/stale-commitments?segment=all",
          "/api/stock/exceptions",
          "/api/stock/adjustments",
          "/api/stock/sync-status",
        ]) {
          const res = await app.inject({ method: "GET", url });
          expect(res.statusCode, url).toBe(200);
        }
        expect(await mirrorDigest(tx)).toEqual(before);
      });
    });

    it("nothing this suite wrote survived its transaction", async () => {
      // Runs against the real pool, outside any transaction: if a fixture ever
      // escaped, the next run would read a polluted database and this is where
      // that shows up.
      const [r] = await realDb!<{ fg: number; lines: number; ov: number; adj: number }[]>`
        select
          (select count(*)::int from erp_live_fg              where sn_fg      like ${`${P}%`}) as fg,
          (select count(*)::int from erp_so_line              where id         like ${`${P}%`}) as lines,
          (select count(*)::int from stock_commitment_overrides where so_line_id like ${`${P}%`}) as ov,
          (select count(*)::int from stock_adjustments        where actor      like ${`${P}%`}) as adj
      `;
      expect(r).toEqual({ fg: 0, lines: 0, ov: 0, adj: 0 });
    });
  });
});
