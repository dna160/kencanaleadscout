/**
 * WP-7 · ATP math, the liveness rule, and the CONTRACTS §7 invariants.
 *
 *     ATP(sku) = on_hand(sku) − open_commitment(sku) + manual_adjustment(sku)
 *
 * Derived on every read, never stored (CONTRACTS §0, invariant §7.1).
 *
 * These tests drive the real schema: the `erp_*` mirror, `v_live_commitments` /
 * `v_stale_commitments` as built by `runErpStockMigrations()`, and the two
 * LeadScout-owned override tables. The liveness predicate is NEVER re-spelled
 * here (invariant §7.3) — every liveness question is asked of the views, which is
 * the only way this suite can actually catch a change to the rule.
 *
 * ISOLATION: this database is shared with the rest of the build, so every
 * DB-touching test runs inside a transaction that is rolled back. Nothing this
 * file writes survives it, and two suites can run concurrently.
 *
 * Without DATABASE_URL the DB block SKIPS rather than fails — CI may have no
 * database, and a red suite for an absent optional dependency is noise.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { canonicalSkuKey, type SkuParts } from "../src/erp/sku.js";
import { closeDatabase, getSql } from "../src/db/client.js";
import { runErpStockMigrations } from "../src/db/migrateErpStock.js";
import { config } from "../src/config.js";

const hasDb = Boolean(process.env.DATABASE_URL);
const WINDOW_DAYS = config.stock.staleWindowDays;
const CANCELLED = config.stock.cancelledStatuses;

/** Everything this file writes is prefixed, so a leaked row is identifiable. */
const P = "wp7atp";
/** Adjustment/override actor, prefixed so `atpFor` can scope to this suite. */
const ACTOR = `${P}.ppic`;

// ── Rollback harness ─────────────────────────────────────────────────────────

class Rollback extends Error {
  constructor() {
    super("wp7 test rollback");
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tx = any;

let db: ReturnType<typeof getSql>;

/** Run `fn` inside a transaction and always roll it back. Returns fn's value. */
async function inRollback<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  let out!: T;
  try {
    await db!.begin(async (tx: Tx) => {
      out = await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
  return out;
}

// ── Fixture builders ─────────────────────────────────────────────────────────

// The 2026-09-11 composition: brand|warna|th|th_panel|p|l, where `th` is the
// aluminium skin and `th_panel` the total panel (erp/sku.ts).
const BLACK_GALAXY: SkuParts = {
  brand: "ACP",
  warna: "4",
  th: 0.3,
  th_panel: 4,
  p: 4880,
  l: 1220,
};
const BG_KEY = canonicalSkuKey(BLACK_GALAXY);

/** `sn_fg` here is the suite's row handle: it seeds the mirror's PRIMARY KEY
 * (`erp_row_id`, the ERP row id) and the roll serial together, so the prefix
 * scoping below still works and the serial is still populated. */
type FgRow = { sn_fg: string; qty: number; parts?: SkuParts };
type LineRow = {
  id: string;
  qty_balance: number;
  /** `null` ⇒ undated (AMENDMENT 1). `number` ⇒ days before today. `string` ⇒ literal date. */
  eta: number | string | null;
  approval?: string;
  status_order?: string;
  parts?: SkuParts;
  so_id?: string;
};

async function seedFg(tx: Tx, rows: readonly FgRow[]): Promise<void> {
  for (const r of rows) {
    const parts = r.parts ?? BLACK_GALAXY;
    await tx`
      insert into erp_live_fg (erp_row_id, sn_fg, kode_barang, brand, warna, th, th_panel, p, l, qty, sku_key)
      values (${r.sn_fg}, ${r.sn_fg}, ${"ACP-4MM"}, ${String(parts.brand ?? "")}, ${String(parts.warna ?? "")},
              ${Number(parts.th ?? 0)}, ${Number(parts.th_panel ?? 0)},
              ${Number(parts.p ?? 0)}, ${Number(parts.l ?? 0)},
              ${r.qty}, ${canonicalSkuKey(parts)})
    `;
  }
}

async function seedHeader(tx: Tx, id: string): Promise<void> {
  await tx`
    insert into erp_so_header (id, so_number, customer_name_text, sales_name_text, status_order)
    values (${id}, ${`SO-${id}`}, ${"PT Pelanggan"}, ${"Rep A"}, ${"Open"})
    on conflict (id) do nothing
  `;
}

async function seedLines(tx: Tx, rows: readonly LineRow[]): Promise<void> {
  for (const r of rows) {
    const parts = r.parts ?? BLACK_GALAXY;
    const soId = r.so_id ?? `${P}-so`;
    await seedHeader(tx, soId);
    // ETA is expressed as an offset so the fixtures move with `current_date`
    // exactly as the view's window does.
    const eta =
      r.eta === null
        ? null
        : typeof r.eta === "number"
          ? tx`(current_date - ${r.eta}::int)`
          : tx`${r.eta}::date`;
    await tx`
      insert into erp_so_line (
        id, so_id, brand, warna, th, th_panel, p, l,
        qty_order, qty_delivered, qty_balance,
        status_order, approval, estimate_delivery, sn_fg, sku_key
      ) values (
        ${r.id}, ${soId}, ${String(parts.brand ?? "")}, ${String(parts.warna ?? "")},
        ${Number(parts.th ?? 0)}, ${Number(parts.th_panel ?? 0)},
        ${Number(parts.p ?? 0)}, ${Number(parts.l ?? 0)},
        ${r.qty_balance}, ${0}, ${r.qty_balance},
        ${r.status_order ?? "Open"}, ${r.approval ?? "Approved"}, ${eta},
        ${null}, ${canonicalSkuKey(parts)}
      )
    `;
  }
}

type Atp = {
  on_hand: number;
  committed: number;
  stale_committed: number;
  adjustment: number;
  atp: number;
};

/**
 * CONTRACTS §0, spelled once in this file. `committed` comes from
 * `v_live_commitments` — the test never re-states the liveness predicate, so a
 * change to the rule changes this number and the assertions catch it.
 */
async function atpFor(tx: Tx, skuKey: string): Promise<Atp> {
  // Scoped to this suite's own prefix. The database is shared with the other work
  // packages' fixtures, which sit on the same Black Galaxy key; without the scope
  // these assertions would measure somebody else's rows.
  const like = `${P}%`;
  const [row] = await tx`
    select
      coalesce((select sum(qty)         from erp_live_fg         t where t.sku_key = ${skuKey} and t.erp_row_id like ${like}), 0)::float8 as on_hand,
      coalesce((select sum(qty_balance) from v_live_commitments  t where t.sku_key = ${skuKey} and t.id    like ${like}), 0)::float8 as committed,
      coalesce((select sum(qty_balance) from v_stale_commitments t where t.sku_key = ${skuKey} and t.id    like ${like}), 0)::float8 as stale_committed,
      coalesce((select sum(qty_delta)   from stock_adjustments   t where t.sku_key = ${skuKey} and t.actor like ${like}), 0)::float8 as adjustment
  `;
  const r = row as Omit<Atp, "atp">;
  return { ...r, atp: r.on_hand - r.committed + r.adjustment };
}

async function idsIn(tx: Tx, relation: "v_live_commitments" | "v_stale_commitments"): Promise<string[]> {
  const rows =
    relation === "v_live_commitments"
      ? await tx`select id from v_live_commitments where id like ${`${P}%`} order by id`
      : await tx`select id from v_stale_commitments where id like ${`${P}%`} order by id`;
  return (rows as { id: string }[]).map((r) => r.id);
}

// ─────────────────────────────────────────────────────────────────────────────
// Static invariants — no database needed, so they always run.
// ─────────────────────────────────────────────────────────────────────────────

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(SRC_ROOT, { recursive: true, encoding: "utf8" })
    .filter((rel) => rel.endsWith(".ts"))
    .map((rel) => join(SRC_ROOT, rel));
}

/**
 * Comments in this codebase quote the rules they are obeying — `stock-atp.ts`
 * says in prose that it never re-spells the predicate and never clamps. Scanning
 * raw text would flag exactly the files that document their own compliance, so
 * strip comments before looking for code.
 */
function codeOf(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
}

describe("CONTRACTS §7 — invariants checkable without a database", () => {
  it("§7.3 the liveness predicate is spelled in exactly one source file", () => {
    // A re-spelling looks like `approval = 'Approved'` next to a `current_date`
    // window in the same file. Only migrateErpStock.ts (which builds the views)
    // is permitted to contain both.
    const allowed = join(SRC_ROOT, "db", "migrateErpStock.ts");
    const offenders = sourceFiles().filter((f) => {
      if (f === allowed) return false;
      const src = codeOf(f);
      return (
        /approval\s*=\s*'Approved'/.test(src) &&
        src.includes("estimate_delivery") &&
        src.includes("current_date")
      );
    });
    expect(offenders).toEqual([]);
  });

  it("§7.1 no source file writes a stored ATP", () => {
    const offenders = sourceFiles().filter((f) => /set\s+atp\s*=/i.test(codeOf(f)));
    expect(offenders).toEqual([]);
  });

  it("§7.5 no source file clamps ATP to zero", () => {
    // `greatest(0, ...)` / Math.max(0, ...) around a commitment subtraction is the
    // exact mistake CONTRACTS §0 forbids: it hides the production signal.
    const offenders = sourceFiles().filter((f) => {
      const src = codeOf(f);
      return (
        (/greatest\s*\(\s*0\s*,/i.test(src) || /Math\.max\s*\(\s*0\s*,/.test(src)) &&
        /qty_balance/.test(src)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("the liveness window is config, never a literal in a consumer", () => {
    expect(WINDOW_DAYS).toBe(60);
    expect(CANCELLED).toEqual(["Cancelled", "Void", "Batal"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The database block.
// ─────────────────────────────────────────────────────────────────────────────

describe.skipIf(!hasDb)("ATP over the real schema", () => {
  beforeAll(async () => {
    db = getSql();
    if (!db) throw new Error("DATABASE_URL is set but getSql() returned null");
    // Exactly what bootDatabase() does. Idempotent; also guarantees the views in
    // this database carry THIS process's window/cancelled-set config.
    await runErpStockMigrations(db);
  }, 60_000);

  afterAll(async () => {
    await closeDatabase();
  });

  // ── The premise of the whole rebuild (PRD §5A) ─────────────────────────────

  describe("the Black Galaxy worked example (PRD §5A)", () => {
    /** 41 stock rows totalling 4,168. */
    const FG: FgRow[] = [
      ...Array.from({ length: 27 }, (_, i) => ({ sn_fg: `${P}-fg-a${i}`, qty: 102 })),
      ...Array.from({ length: 14 }, (_, i) => ({ sn_fg: `${P}-fg-b${i}`, qty: 101 })),
    ];
    /** 8 live lines totalling 319 — ETAs inside the window. */
    const LIVE: LineRow[] = [
      ...Array.from({ length: 7 }, (_, i) => ({
        id: `${P}-live-${i}`,
        qty_balance: 40,
        eta: i * 5,
      })),
      { id: `${P}-live-7`, qty_balance: 39, eta: 45 },
    ];
    /** 68 stale lines totalling 1,810 — the phantoms, oldest 2020-08-27. */
    const STALE: LineRow[] = [
      { id: `${P}-stale-oldest`, qty_balance: 27, eta: "2020-08-27" },
      ...Array.from({ length: 41 }, (_, i) => ({
        id: `${P}-stale-a${i}`,
        qty_balance: 27,
        eta: 61 + i,
      })),
      ...Array.from({ length: 26 }, (_, i) => ({
        id: `${P}-stale-b${i}`,
        qty_balance: 26,
        eta: 200 + i,
      })),
    ];

    it("reproduces 4,168 on-hand − 319 live = ATP 3,849, with 1,810 quarantined", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, FG);
        await seedLines(tx, [...LIVE, ...STALE]);

        const a = await atpFor(tx, BG_KEY);

        expect(FG.length).toBe(41);
        expect(LIVE.length + STALE.length).toBe(76);
        expect(a.on_hand).toBe(4168);
        expect(a.committed).toBe(319);
        expect(a.stale_committed).toBe(1810);
        expect(a.committed + a.stale_committed).toBe(2129); // the naive "open" figure
        expect(a.atp).toBe(3849);

        // The point of the entire rebuild: the naive readings are wrong.
        expect(a.atp).not.toBe(2039); // 4168 − 2129, all "open" balances counted
        expect(a.atp).not.toBe(2029);
      });
    });

    it("the oldest phantom (ETA 2020-08-27) is quarantined, not summed", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, FG);
        await seedLines(tx, [...LIVE, ...STALE]);
        expect(await idsIn(tx, "v_live_commitments")).not.toContain(`${P}-stale-oldest`);
        expect(await idsIn(tx, "v_stale_commitments")).toContain(`${P}-stale-oldest`);
      });
    });

    it("every stale line is reviewable — nothing is silently dropped (ST-R18)", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, FG);
        await seedLines(tx, [...LIVE, ...STALE]);
        const stale = await idsIn(tx, "v_stale_commitments");
        expect(stale.sort()).toEqual(STALE.map((l) => l.id).sort());
      });
    });
  });

  // ── The window boundary ───────────────────────────────────────────────────

  describe(`liveness window boundary (ST-R17, ${WINDOW_DAYS} days)`, () => {
    it(`a line at exactly today − ${WINDOW_DAYS} is LIVE`, async () => {
      await inRollback(async (tx) => {
        await seedLines(tx, [{ id: `${P}-edge-in`, qty_balance: 5, eta: WINDOW_DAYS }]);
        expect(await idsIn(tx, "v_live_commitments")).toEqual([`${P}-edge-in`]);
        expect(await idsIn(tx, "v_stale_commitments")).toEqual([]);
      });
    });

    it(`a line at today − ${WINDOW_DAYS + 1} is STALE`, async () => {
      await inRollback(async (tx) => {
        await seedLines(tx, [{ id: `${P}-edge-out`, qty_balance: 5, eta: WINDOW_DAYS + 1 }]);
        expect(await idsIn(tx, "v_live_commitments")).toEqual([]);
        expect(await idsIn(tx, "v_stale_commitments")).toEqual([`${P}-edge-out`]);
      });
    });

    it("the boundary moves exactly one line, and only one", async () => {
      // Off-by-one here silently reclassifies thousands of rows, so assert the
      // whole neighbourhood at once rather than one side of it.
      await inRollback(async (tx) => {
        await seedLines(tx, [
          { id: `${P}-w58`, qty_balance: 1, eta: WINDOW_DAYS - 2 },
          { id: `${P}-w59`, qty_balance: 1, eta: WINDOW_DAYS - 1 },
          { id: `${P}-w60`, qty_balance: 1, eta: WINDOW_DAYS },
          { id: `${P}-w61`, qty_balance: 1, eta: WINDOW_DAYS + 1 },
          { id: `${P}-w62`, qty_balance: 1, eta: WINDOW_DAYS + 2 },
        ]);
        expect(await idsIn(tx, "v_live_commitments")).toEqual([
          `${P}-w58`,
          `${P}-w59`,
          `${P}-w60`,
        ]);
        expect(await idsIn(tx, "v_stale_commitments")).toEqual([`${P}-w61`, `${P}-w62`]);
      });
    });

    it("a future ETA is live", async () => {
      await inRollback(async (tx) => {
        await seedLines(tx, [{ id: `${P}-future`, qty_balance: 5, eta: -30 }]);
        expect(await idsIn(tx, "v_live_commitments")).toEqual([`${P}-future`]);
      });
    });
  });

  // ── AMENDMENT 1 ───────────────────────────────────────────────────────────

  describe("AMENDMENT 1 — an approved line with estimate_delivery IS NULL reserves stock", () => {
    it("v_live_commitments exposes the `undated` flag column", async () => {
      const rows = await db!<{ column_name: string }[]>`
        select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'v_live_commitments'
      `;
      const cols = rows.map((r) => r.column_name);
      expect(cols).toContain("undated");
    });

    it("the undated line is LIVE and reduces ATP", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-u`, qty: 100 }]);
        await seedLines(tx, [{ id: `${P}-undated`, qty_balance: 30, eta: null }]);

        // The pre-amendment regression: the line matched neither ETA branch, fell
        // out of both views, reserved nothing, and silently inflated ATP to 100.
        const a = await atpFor(tx, BG_KEY);
        expect(a.committed).toBe(30);
        expect(a.atp).toBe(70);
        expect(a.atp).not.toBe(100);
      });
    });

    it("the undated line is NOT in the stale view (a missing date is not evidence of death)", async () => {
      await inRollback(async (tx) => {
        await seedLines(tx, [{ id: `${P}-undated`, qty_balance: 30, eta: null }]);
        expect(await idsIn(tx, "v_live_commitments")).toEqual([`${P}-undated`]);
        expect(await idsIn(tx, "v_stale_commitments")).toEqual([]);
      });
    });

    it("the undated line is flagged `undated` and is therefore reviewable by PPIC", async () => {
      await inRollback(async (tx) => {
        await seedLines(tx, [
          { id: `${P}-undated`, qty_balance: 30, eta: null },
          { id: `${P}-dated`, qty_balance: 10, eta: 3 },
        ]);
        const rows = await tx`
          select id, undated from v_live_commitments where id like ${`${P}%`} order by id
        `;
        expect(rows).toEqual([
          { id: `${P}-dated`, undated: false },
          { id: `${P}-undated`, undated: true },
        ]);
      });
    });

    it("confirm-closing a phantom undated line stops the reservation (ST-R21)", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-u`, qty: 100 }]);
        await seedLines(tx, [{ id: `${P}-undated`, qty_balance: 30, eta: null }]);
        expect((await atpFor(tx, BG_KEY)).atp).toBe(70);

        await tx`
          insert into stock_commitment_overrides (so_line_id, state, reason, actor)
          values (${`${P}-undated`}, 'closed', 'phantom, confirmed by PPIC', ${ACTOR})
        `;
        expect((await atpFor(tx, BG_KEY)).atp).toBe(100);
      });
    });
  });

  // ── Negative ATP (invariant §7.5) ─────────────────────────────────────────

  describe("negative ATP is surfaced, never clamped (invariant §7.5)", () => {
    it("committed beyond on-hand yields a negative number", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-n`, qty: 10 }]);
        await seedLines(tx, [{ id: `${P}-over`, qty_balance: 30, eta: 5 }]);
        const a = await atpFor(tx, BG_KEY);
        expect(a.atp).toBe(-20);
        expect(a.atp).toBeLessThan(0);
      });
    });

    it("demand for a SKU with no stock row at all reads as fully negative", async () => {
      // ST-R5.3: unmatched demand must read ATP-negative, never vanish.
      await inRollback(async (tx) => {
        await seedLines(tx, [{ id: `${P}-nofg`, qty_balance: 75, eta: 5 }]);
        const a = await atpFor(tx, BG_KEY);
        expect(a.on_hand).toBe(0);
        expect(a.committed).toBe(75);
        expect(a.atp).toBe(-75);
      });
    });

    it("a negative adjustment can drive ATP below zero", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-n`, qty: 10 }]);
        await tx`
          insert into stock_adjustments (sku_key, qty_delta, reason, actor)
          values (${BG_KEY}, ${-25}, 'opname: kerusakan gudang', ${ACTOR})
        `;
        expect((await atpFor(tx, BG_KEY)).atp).toBe(-15);
      });
    });
  });

  // ── Manual adjustments (ST-R12 / ST-R20, invariant §7.2) ─────────────────

  describe("manual adjustments apply signed and additively", () => {
    it("sums signed deltas into ATP", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-a`, qty: 100 }]);
        await seedLines(tx, [{ id: `${P}-c1`, qty_balance: 20, eta: 5 }]);
        await tx`
          insert into stock_adjustments (sku_key, qty_delta, reason, actor) values
            (${BG_KEY}, ${-5},  'opname: pecah',        ${ACTOR}),
            (${BG_KEY}, ${12},  'penerimaan tak tercatat',${ACTOR}),
            (${BG_KEY}, ${-2},  'koreksi hitung',        ${ACTOR})
        `;
        const a = await atpFor(tx, BG_KEY);
        expect(a.adjustment).toBe(5);
        expect(a.atp).toBe(85); // 100 − 20 + 5
      });
    });

    it("never mutates erp_live_fg (invariant §7.2)", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-a`, qty: 100 }]);
        const before = await tx`
          select qty::float8 as qty, synced_at from erp_live_fg where sn_fg = ${`${P}-fg-a`}
        `;
        await tx`
          insert into stock_adjustments (sku_key, qty_delta, reason, actor)
          values (${BG_KEY}, ${-40}, 'opname', ${ACTOR})
        `;
        const after = await tx`
          select qty::float8 as qty, synced_at from erp_live_fg where sn_fg = ${`${P}-fg-a`}
        `;
        expect(after).toEqual(before);
        expect((await atpFor(tx, BG_KEY)).on_hand).toBe(100); // on-hand is untouched
        expect((await atpFor(tx, BG_KEY)).atp).toBe(60);
      });
    });

    it("adjustments are per-SKU and do not leak across keys", async () => {
      const other: SkuParts = { ...BLACK_GALAXY, warna: "005" };
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-a`, qty: 100 }]);
        await seedFg(tx, [{ sn_fg: `${P}-fg-o`, qty: 50, parts: other }]);
        await tx`
          insert into stock_adjustments (sku_key, qty_delta, reason, actor)
          values (${canonicalSkuKey(other)}, ${-10}, 'opname', ${ACTOR})
        `;
        expect((await atpFor(tx, BG_KEY)).atp).toBe(100);
        expect((await atpFor(tx, canonicalSkuKey(other))).atp).toBe(40);
      });
    });

    it("the schema enforces an audited actor and a reason (invariant §7.8, ST-R12)", async () => {
      await inRollback(async (tx) => {
        await expect(
          tx`insert into stock_adjustments (sku_key, qty_delta, actor) values (${BG_KEY}, ${1}, 'x')`,
        ).rejects.toThrow();
      });
      await inRollback(async (tx) => {
        await expect(
          tx`insert into stock_adjustments (sku_key, qty_delta, reason) values (${BG_KEY}, ${1}, 'r')`,
        ).rejects.toThrow();
      });
      await inRollback(async (tx) => {
        await expect(
          tx`insert into stock_commitment_overrides (so_line_id, state) values (${`${P}-x`}, 'closed')`,
        ).rejects.toThrow();
      });
    });
  });

  // ── Confirm-close / reinstate (ST-R21) ───────────────────────────────────

  describe("confirm-close and reinstate (ST-R21)", () => {
    it("a confirm-closed live commitment stops reducing ATP; reinstating restores it", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-r`, qty: 100 }]);
        await seedLines(tx, [{ id: `${P}-line`, qty_balance: 30, eta: 5 }]);
        expect((await atpFor(tx, BG_KEY)).atp).toBe(70);

        await tx`
          insert into stock_commitment_overrides (so_line_id, state, reason, actor)
          values (${`${P}-line`}, 'closed', 'phantom', ${ACTOR})
        `;
        expect((await atpFor(tx, BG_KEY)).atp).toBe(100);
        expect(await idsIn(tx, "v_live_commitments")).toEqual([]);

        await tx`
          update stock_commitment_overrides
          set state = 'reinstated', actor = ${ACTOR}, updated_at = now()
          where so_line_id = ${`${P}-line`}
        `;
        expect((await atpFor(tx, BG_KEY)).atp).toBe(70);
        expect(await idsIn(tx, "v_live_commitments")).toEqual([`${P}-line`]);
      });
    });

    it("the override row survives a reinstate, so the decision keeps an audit trail", async () => {
      await inRollback(async (tx) => {
        await seedLines(tx, [{ id: `${P}-line`, qty_balance: 30, eta: 5 }]);
        await tx`
          insert into stock_commitment_overrides (so_line_id, state, reason, actor)
          values (${`${P}-line`}, 'closed', 'phantom', ${ACTOR})
        `;
        await tx`
          update stock_commitment_overrides set state = 'reinstated', actor = ${`${P}.ppic.b`} where so_line_id = ${`${P}-line`}
        `;
        const rows = await tx`
          select state, actor, created_at is not null as has_created
          from stock_commitment_overrides where so_line_id = ${`${P}-line`}
        `;
        expect(rows).toEqual([{ state: "reinstated", actor: `${P}.ppic.b`, has_created: true }]);
      });
    });

    it("closing a stale line removes it from the review queue without touching ATP", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-s`, qty: 100 }]);
        await seedLines(tx, [{ id: `${P}-stale`, qty_balance: 30, eta: 400 }]);
        const before = await atpFor(tx, BG_KEY);
        expect(before.atp).toBe(100);
        expect(before.stale_committed).toBe(30);

        await tx`
          insert into stock_commitment_overrides (so_line_id, state, reason, actor)
          values (${`${P}-stale`}, 'closed', 'phantom 2020', ${ACTOR})
        `;
        const after = await atpFor(tx, BG_KEY);
        expect(after.atp).toBe(100);
        expect(after.stale_committed).toBe(0);
        expect(await idsIn(tx, "v_stale_commitments")).toEqual([]);
      });
    });
  });

  // ── AMENDMENT 6a — the consequence of a close, per population ────────────

  describe("AMENDMENT 6a — closing has opposite consequences for stale and undated lines", () => {
    /** The exact number `atp_delta` must report. Computed, never assumed. */
    async function closeAndMeasure(tx: Tx, lineId: string): Promise<number> {
      const before = (await atpFor(tx, BG_KEY)).atp;
      await tx`
        insert into stock_commitment_overrides (so_line_id, state, reason, actor)
        values (${lineId}, 'closed', 'triage', ${ACTOR})
      `;
      const after = (await atpFor(tx, BG_KEY)).atp;
      return after - before;
    }

    it("closing a STALE line moves ATP by exactly zero", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-6a`, qty: 1000 }]);
        await seedLines(tx, [{ id: `${P}-6a-stale`, qty_balance: 1200, eta: 900 }]);
        expect(await closeAndMeasure(tx, `${P}-6a-stale`)).toBe(0);
      });
    });

    it("closing an UNDATED line releases its entire balance into ATP", async () => {
      // This is the asymmetry AMENDMENT 6 exists for: an operator who learns
      // "closing does nothing" from the stale queue would silently release
      // reserved stock here. The number must be surfaced, not inferred.
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-6a`, qty: 1000 }]);
        await seedLines(tx, [{ id: `${P}-6a-undated`, qty_balance: 1200, eta: null }]);
        expect(await closeAndMeasure(tx, `${P}-6a-undated`)).toBe(1200);
      });
    });

    it("closing a dated LIVE line releases its balance too", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-6a`, qty: 1000 }]);
        await seedLines(tx, [{ id: `${P}-6a-live`, qty_balance: 300, eta: 5 }]);
        expect(await closeAndMeasure(tx, `${P}-6a-live`)).toBe(300);
      });
    });

    it("AMENDMENT 6c — a closed row leaves both views, so the undo path needs its own segment", async () => {
      // `segment=closed` is not optional: without it a confirm-close is
      // unrecoverable from the UI after a reload, because the row is in neither
      // view. Assert the premise; the route-level filter is WP-3's to test.
      await inRollback(async (tx) => {
        await seedLines(tx, [{ id: `${P}-6c`, qty_balance: 50, eta: 900 }]);
        await tx`
          insert into stock_commitment_overrides (so_line_id, state, reason, actor)
          values (${`${P}-6c`}, 'closed', 'triage', ${ACTOR})
        `;
        expect(await idsIn(tx, "v_live_commitments")).toEqual([]);
        expect(await idsIn(tx, "v_stale_commitments")).toEqual([]);
        const rows = await tx`
          select so_line_id from stock_commitment_overrides where so_line_id = ${`${P}-6c`}
        `;
        expect(rows).toEqual([{ so_line_id: `${P}-6c` }]); // recoverable only from here
      });
    });
  });

  // ── Dead demand must not reserve ─────────────────────────────────────────

  describe("dead demand reserves nothing", () => {
    it("unapproved, cancelled and zero-balance lines are excluded from ATP", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-d`, qty: 100 }]);
        await seedLines(tx, [
          { id: `${P}-draft`, qty_balance: 11, eta: 5, approval: "Waiting" },
          { id: `${P}-cancel`, qty_balance: 12, eta: 5, status_order: CANCELLED[0] ?? "Cancelled" },
          { id: `${P}-void`, qty_balance: 13, eta: 5, status_order: CANCELLED[1] ?? "Void" },
          { id: `${P}-batal`, qty_balance: 14, eta: 5, status_order: CANCELLED[2] ?? "Batal" },
          { id: `${P}-delivered`, qty_balance: 0, eta: 5 },
          { id: `${P}-real`, qty_balance: 20, eta: 5 },
        ]);
        const a = await atpFor(tx, BG_KEY);
        expect(a.committed).toBe(20);
        expect(a.atp).toBe(80);
        expect(await idsIn(tx, "v_live_commitments")).toEqual([`${P}-real`]);
        expect(await idsIn(tx, "v_stale_commitments")).toEqual([]);
      });
    });

    it("a fully delivered line self-cleans without a manual close (PRD §2.3)", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-d`, qty: 100 }]);
        await seedLines(tx, [{ id: `${P}-l`, qty_balance: 30, eta: 5 }]);
        expect((await atpFor(tx, BG_KEY)).atp).toBe(70);
        await tx`update erp_so_line set qty_delivered = 30, qty_balance = 0 where id = ${`${P}-l`}`;
        expect((await atpFor(tx, BG_KEY)).atp).toBe(100);
      });
    });
  });

  // ── The partition property (invariant §7.6 as reworded by AMENDMENT 2) ───

  describe("invariant §7.6 — live / stale / exception partition every countable line", () => {
    /**
     * The universe, per AMENDMENT 2: approved, non-cancelled, `qty_balance > 0`.
     * Confirm-closed lines are excluded from the universe too — a closed line is
     * a recorded human decision with an actor and a timestamp in
     * `stock_commitment_overrides`, which is the opposite of "silently dropped".
     * That narrowing is implied by §0 but not spelled in §7.6; see the WP-7 report.
     *
     * With the schema as built there is no third bucket: an unmatched SKU is
     * still a live commitment (ST-R5.3 requires it to read ATP-negative, not to
     * vanish), and the ST-R5.4 UoM exception cannot occur because the mirror
     * carries no unit column. So the exception set must be EMPTY, and the
     * partition reduces to `live ⊎ stale = U`. A line in the residual is exactly
     * the failure mode the stale queue exists to prevent.
     */
    const POPULATION: LineRow[] = [
      // live, in every shape
      { id: `${P}-p-live-future`, qty_balance: 3, eta: -10 },
      { id: `${P}-p-live-today`, qty_balance: 3, eta: 0 },
      { id: `${P}-p-live-edge`, qty_balance: 3, eta: WINDOW_DAYS },
      { id: `${P}-p-live-frac`, qty_balance: 0.5, eta: 7 },
      { id: `${P}-p-live-nofg`, qty_balance: 9, eta: 7, parts: { ...BLACK_GALAXY, warna: "ZZZ" } },
      // undated — AMENDMENT 1 says live
      { id: `${P}-p-undated-1`, qty_balance: 4, eta: null },
      { id: `${P}-p-undated-2`, qty_balance: 4, eta: null, parts: { ...BLACK_GALAXY, p: 3660 } },
      // stale
      { id: `${P}-p-stale-edge`, qty_balance: 3, eta: WINDOW_DAYS + 1 },
      { id: `${P}-p-stale-2020`, qty_balance: 3, eta: "2020-08-27" },
      { id: `${P}-p-stale-do`, qty_balance: 3, eta: 900, status_order: "DO" },
      // outside the universe — dead demand
      { id: `${P}-p-dead-draft`, qty_balance: 5, eta: 5, approval: "Waiting" },
      { id: `${P}-p-dead-draft-null`, qty_balance: 5, eta: null, approval: "Draft" },
      { id: `${P}-p-dead-cancel`, qty_balance: 5, eta: 5, status_order: "Cancelled" },
      { id: `${P}-p-dead-void`, qty_balance: 5, eta: null, status_order: "Void" },
      { id: `${P}-p-dead-batal`, qty_balance: 5, eta: 900, status_order: "Batal" },
      { id: `${P}-p-dead-zero`, qty_balance: 0, eta: 5 },
      { id: `${P}-p-dead-zero-null`, qty_balance: 0, eta: null },
    ];

    async function universe(tx: Tx): Promise<string[]> {
      const rows = await tx`
        select l.id
        from erp_so_line l
        left join stock_commitment_overrides o on o.so_line_id = l.id
        where l.id like ${`${P}%`}
          and l.approval = 'Approved'
          and l.qty_balance > 0
          and coalesce(l.status_order, '') <> all (${CANCELLED as string[]})
          and coalesce(o.state, '') <> 'closed'
        order by l.id
      `;
      return (rows as { id: string }[]).map((r) => r.id);
    }

    it("live and stale are disjoint", async () => {
      await inRollback(async (tx) => {
        await seedLines(tx, POPULATION);
        const live = new Set(await idsIn(tx, "v_live_commitments"));
        const stale = await idsIn(tx, "v_stale_commitments");
        expect(stale.filter((id) => live.has(id))).toEqual([]);
      });
    });

    it("live ∪ stale covers the universe — the exception residual is empty", async () => {
      await inRollback(async (tx) => {
        await seedLines(tx, POPULATION);
        const u = await universe(tx);
        const classified = new Set([
          ...(await idsIn(tx, "v_live_commitments")),
          ...(await idsIn(tx, "v_stale_commitments")),
        ]);
        // Every countable line must land somewhere. A line in this residual
        // reserves nothing AND appears in no queue: it silently inflates ATP.
        expect(u.filter((id) => !classified.has(id))).toEqual([]);
      });
    });

    it("neither view reaches outside the universe", async () => {
      await inRollback(async (tx) => {
        await seedLines(tx, POPULATION);
        const u = new Set(await universe(tx));
        const classified = [
          ...(await idsIn(tx, "v_live_commitments")),
          ...(await idsIn(tx, "v_stale_commitments")),
        ];
        expect(classified.filter((id) => !u.has(id))).toEqual([]);
      });
    });

    it("the partition still holds once half the population is confirm-closed", async () => {
      await inRollback(async (tx) => {
        await seedLines(tx, POPULATION);
        for (const id of [`${P}-p-live-future`, `${P}-p-stale-2020`, `${P}-p-undated-1`]) {
          await tx`
            insert into stock_commitment_overrides (so_line_id, state, reason, actor)
            values (${id}, 'closed', 'triage', ${ACTOR})
          `;
        }
        const u = await universe(tx);
        const live = new Set(await idsIn(tx, "v_live_commitments"));
        const stale = await idsIn(tx, "v_stale_commitments");
        expect(stale.filter((id) => live.has(id))).toEqual([]);
        const classified = new Set([...live, ...stale]);
        expect(u.filter((id) => !classified.has(id))).toEqual([]);
        expect([...classified].filter((id) => !u.includes(id))).toEqual([]);
      });
    });

    it("the seeded population actually exercises all three outcomes", async () => {
      // Guards against a vacuous pass: if the fixtures degenerated to one bucket
      // the property above would be trivially true.
      await inRollback(async (tx) => {
        await seedLines(tx, POPULATION);
        const u = await universe(tx);
        const live = await idsIn(tx, "v_live_commitments");
        const stale = await idsIn(tx, "v_stale_commitments");
        const all = await tx`select id from erp_so_line where id like ${`${P}%`}`;
        expect(live.length).toBeGreaterThanOrEqual(5);
        expect(stale.length).toBeGreaterThanOrEqual(3);
        expect(u.length).toBeLessThan((all as unknown[]).length); // dead demand exists
      });
    });
  });

  // ── Idempotency / purity of the read path ────────────────────────────────

  describe("computing ATP is idempotent and side-effect free", () => {
    it("two identical reads over unchanged data give the same answer", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [
          { sn_fg: `${P}-fg-i1`, qty: 40 },
          { sn_fg: `${P}-fg-i2`, qty: 60 },
        ]);
        // Deliberately no undated line here: AMENDMENT 1 is asserted in its own
        // block, and mixing it in would let that failure masquerade as an
        // idempotency failure.
        await seedLines(tx, [
          { id: `${P}-i-live`, qty_balance: 15, eta: 5 },
          { id: `${P}-i-live2`, qty_balance: 5, eta: 50 },
          { id: `${P}-i-stale`, qty_balance: 99, eta: 400 },
        ]);
        await tx`
          insert into stock_adjustments (sku_key, qty_delta, reason, actor)
          values (${BG_KEY}, ${-3}, 'opname', ${ACTOR})
        `;
        const first = await atpFor(tx, BG_KEY);
        const second = await atpFor(tx, BG_KEY);
        const third = await atpFor(tx, BG_KEY);
        expect(second).toEqual(first);
        expect(third).toEqual(first);
        expect(first.atp).toBe(100 - 20 - 3); // 77; the stale 99 stays quarantined
      });
    });

    it("no read mutates the mirror", async () => {
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-i1`, qty: 40 }]);
        await seedLines(tx, [{ id: `${P}-i-live`, qty_balance: 15, eta: 5 }]);
        const snapshot = async () => {
          const [r] = await tx`
            select
              (select md5(string_agg(t::text, '|' order by t.sn_fg)) from erp_live_fg t where t.sn_fg like ${`${P}%`}) as fg,
              (select md5(string_agg(t::text, '|' order by t.id))    from erp_so_line t where t.id like ${`${P}%`}) as lines
          `;
          return r as { fg: string; lines: string };
        };
        const before = await snapshot();
        await atpFor(tx, BG_KEY);
        await idsIn(tx, "v_live_commitments");
        await idsIn(tx, "v_stale_commitments");
        await atpFor(tx, BG_KEY);
        expect(await snapshot()).toEqual(before);
      });
    });

    it("re-upserting the same mirror rows (a repeated sync window) does not change ATP", async () => {
      // ST-R6: the mirror is upsert-by-PK, so replaying a window is a no-op.
      await inRollback(async (tx) => {
        await seedFg(tx, [{ sn_fg: `${P}-fg-i1`, qty: 40 }]);
        await seedLines(tx, [{ id: `${P}-i-live`, qty_balance: 15, eta: 5 }]);
        const before = await atpFor(tx, BG_KEY);
        await tx`
          insert into erp_live_fg (erp_row_id, sn_fg, kode_barang, brand, warna, th, th_panel, p, l, qty, sku_key)
          values (${`${P}-fg-i1`}, ${`${P}-fg-i1`}, 'ACP-4MM', 'ACP', '4', 0.3, 4, 4880, 1220, 40, ${BG_KEY})
          on conflict (erp_row_id) do update set qty = excluded.qty, synced_at = now()
        `;
        expect(await atpFor(tx, BG_KEY)).toEqual(before);
      });
    });
  });

  // ── Schema-level invariants ──────────────────────────────────────────────

  describe("schema invariants", () => {
    it("§7.1 no table or view anywhere carries a stored `atp` column", async () => {
      const rows = await db!<{ table_name: string }[]>`
        select table_name from information_schema.columns
        where table_schema = 'public' and lower(column_name) in ('atp', 'atp_qty', 'available_to_promise')
      `;
      expect(rows).toEqual([]);
    });

    it("the canonical unit is lembar — qty_m2 is display only (ST-R5.4)", async () => {
      // If a future change started summing qty_m2 into the same total as qty the
      // numbers would silently mix units; pin that qty is the ATP input.
      await inRollback(async (tx) => {
        await tx`
          insert into erp_live_fg (erp_row_id, sn_fg, kode_barang, brand, warna, th, th_panel, p, l, qty, qty_m2, sku_key)
          values (${`${P}-fg-m2`}, ${`${P}-fg-m2`}, 'ACP-4MM', 'ACP', '4', 0.3, 4, 4880, 1220, 10, 59.536, ${BG_KEY})
        `;
        expect((await atpFor(tx, BG_KEY)).on_hand).toBe(10);
      });
    });

    it("erp_sync_state is pre-seeded with every mirrored table (ST-R6)", async () => {
      const rows = await db!<{ table_name: string }[]>`
        select table_name from erp_sync_state order by table_name
      `;
      // `warna` joined them on 2026-09-11: the colour master is mirrored like any
      // other table, so it shares the cursor, the lock and the failure handling.
      expect(rows.map((r) => r.table_name)).toEqual(["live_fg", "so_header", "so_line", "warna"]);
    });
  });
});
