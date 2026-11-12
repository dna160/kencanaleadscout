/**
 * WP-1 (Kabar Pesanan PRD §4 / §14): the SO mirror is keyed on `po_no`.
 *
 * Verified 2026-11-10: Selaras carries the SO number as `po_no` on BOTH
 * tbl_1202 (header) and tbl_1203 (lines), and has no line→header id column.
 * The mirror used to read `so_number`/`no_so`/… and `so_id`/…, none of which
 * exist upstream, so every commitment joined to no header.
 *
 * Pure adapter checks always run; the view and migration checks need
 * DATABASE_URL and skip without it, like the rest of the DB suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { adaptSoHeaderRow, adaptSoLineRow } from "../src/erp/selarasClient.js";
import { canonicalSkuKey, type SkuParts } from "../src/erp/sku.js";
import { closeDatabase, getSql } from "../src/db/client.js";
import { runErpStockMigrations } from "../src/db/migrateErpStock.js";

const HEADER_TABLE_ID = "tbl_1202_SOSalesOrderNID_id";
const LINE_TABLE_ID = "tbl_1203_SOSalesOrderDetailNID_id";

describe("adapters read po_no (WP-1)", () => {
  it("header: po_no is the SO number, and so_number mirrors it", () => {
    const r = adaptSoHeaderRow({
      [HEADER_TABLE_ID]: 75001,
      po_no: "SO.26/12821",
      customer_name_text: "FITRAH JAYA",
      po_date: "2026-11-09",
    });
    expect(r).toMatchObject({ id: "75001", po_no: "SO.26/12821", so_number: "SO.26/12821" });
  });

  it("header without po_no keeps the legacy so_number fallbacks", () => {
    const r = adaptSoHeaderRow({ [HEADER_TABLE_ID]: 1, no_so: "SO-LEGACY" });
    expect(r).toMatchObject({ po_no: null, so_number: "SO-LEGACY" });
  });

  it("line: po_no is carried as the join key; so_id stays null when absent", () => {
    const r = adaptSoLineRow({
      [LINE_TABLE_ID]: 142001,
      po_no: "SO.26/12821",
      brand: "1",
      warna: "4",
      th_alu_skin: "0.21",
      total_thickness_acp: "4",
      qty_order: "5",
      qty_balance: "5",
    });
    expect(r).toMatchObject({ id: "142001", po_no: "SO.26/12821", so_id: null });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);
const P = "wp1sokey";

class Rollback extends Error {}
/* eslint-disable @typescript-eslint/no-explicit-any */
type Tx = any;
let db: ReturnType<typeof getSql>;

async function inRollback(fn: (tx: Tx) => Promise<void>): Promise<void> {
  try {
    await db!.begin(async (tx: Tx) => {
      await fn(tx);
      throw new Rollback();
    });
  } catch (err) {
    if (!(err instanceof Rollback)) throw err;
  }
}

/** A SKU nobody else seeds, so Σ over the views is this suite's alone. */
const PARTS: SkuParts = { brand: "WP1", warna: "991", th: 0.21, th_panel: 4, p: 2440, l: 1220 };
const KEY = canonicalSkuKey(PARTS);

async function seedHeader(
  tx: Tx,
  h: { id: string; po_no: string | null; customer: string; updatedDaysAgo?: number },
): Promise<void> {
  await tx`
    insert into erp_so_header (id, po_no, so_number, customer_name_text, sales_name_text, status_order, erp_updated_at)
    values (${h.id}, ${h.po_no}, ${h.po_no}, ${h.customer}, ${"Rep WP1"}, ${"Open"},
            now() - make_interval(days => ${h.updatedDaysAgo ?? 0}))
  `;
}

async function seedLine(
  tx: Tx,
  l: { id: string; po_no: string | null; so_id?: string | null; qty: number },
): Promise<void> {
  await tx`
    insert into erp_so_line (
      id, po_no, so_id, brand, warna, th, th_panel, p, l,
      qty_order, qty_delivered, qty_balance, status_order, approval, estimate_delivery, sku_key
    ) values (
      ${l.id}, ${l.po_no}, ${l.so_id ?? null}, ${PARTS.brand as string}, ${PARTS.warna as string},
      ${PARTS.th as number}, ${PARTS.th_panel as number}, ${PARTS.p as number}, ${PARTS.l as number},
      ${l.qty}, ${0}, ${l.qty}, ${"Open"}, ${"Approved"}, current_date, ${KEY}
    )
  `;
}

async function liveRows(tx: Tx) {
  return tx<{ id: string; so_number: string | null; customer_name_text: string | null; qty_balance: string }[]>`
    select id, so_number, customer_name_text, qty_balance::text
      from v_live_commitments where sku_key = ${KEY} order by id
  `;
}

describe.skipIf(!hasDb)("SO header join over the real views (WP-1)", () => {
  beforeAll(async () => {
    db = getSql();
    if (!db) throw new Error("DATABASE_URL is set but getSql() returned null");
    await runErpStockMigrations(db);
  }, 60_000);
  afterAll(async () => {
    await closeDatabase();
  });

  it("a line with po_no and no so_id finds its header", async () => {
    await inRollback(async (tx) => {
      await seedHeader(tx, { id: `${P}-h1`, po_no: `${P}/0001`, customer: "FITRAH JAYA" });
      await seedLine(tx, { id: `${P}-l1`, po_no: `${P}/0001`, qty: 7 });
      const rows = await liveRows(tx);
      expect(rows).toEqual([
        { id: `${P}-l1`, so_number: `${P}/0001`, customer_name_text: "FITRAH JAYA", qty_balance: "7" },
      ]);
    });
  });

  it("two header rows with the same po_no never duplicate the line (ATP-safe)", async () => {
    await inRollback(async (tx) => {
      await seedHeader(tx, { id: `${P}-h-old`, po_no: `${P}/0002`, customer: "OLD NAME", updatedDaysAgo: 5 });
      await seedHeader(tx, { id: `${P}-h-new`, po_no: `${P}/0002`, customer: "NEW NAME", updatedDaysAgo: 0 });
      await seedLine(tx, { id: `${P}-l2`, po_no: `${P}/0002`, qty: 11 });
      const rows = await liveRows(tx);
      // One line in, one row out: Σ qty_balance (what ATP subtracts) is 11, not 22.
      expect(rows).toHaveLength(1);
      expect(rows[0]!.qty_balance).toBe("11");
      // The most recently updated header wins the display fields.
      expect(rows[0]!.customer_name_text).toBe("NEW NAME");
    });
  });

  it("a line without po_no still joins on the legacy so_id", async () => {
    await inRollback(async (tx) => {
      await seedHeader(tx, { id: `${P}-h3`, po_no: null, customer: "LEGACY" });
      await seedLine(tx, { id: `${P}-l3`, po_no: null, so_id: `${P}-h3`, qty: 3 });
      const [row] = await liveRows(tx);
      expect(row).toMatchObject({ id: `${P}-l3`, customer_name_text: "LEGACY" });
    });
  });

  it("a line whose po_no matches no header still reserves stock (header fields null)", async () => {
    await inRollback(async (tx) => {
      await seedLine(tx, { id: `${P}-l4`, po_no: `${P}/MISSING`, qty: 4 });
      const rows = await liveRows(tx);
      expect(rows).toEqual([{ id: `${P}-l4`, so_number: null, customer_name_text: null, qty_balance: "4" }]);
    });
  });
});

describe.skipIf(!hasDb)("WP-1 migration on a pre-po_no mirror", () => {
  beforeAll(async () => {
    db = getSql();
    if (!db) throw new Error("DATABASE_URL is set but getSql() returned null");
  });
  afterAll(async () => {
    await closeDatabase();
  });

  // Runs in a private schema inside a rolled-back transaction: the DDL below
  // (dropping columns, recreating views) must not take locks on the relations
  // the other suites are reading concurrently.
  it("adds po_no to both SO tables and resets ONLY the SO cursors, once", async () => {
    const schema = `${P}_mig`;
    await inRollback(async (tx) => {
      await tx.unsafe(`create schema ${schema}`);
      await tx.unsafe(`set local search_path to ${schema}`);

      // A fresh database: po_no is created with the tables, so no reset is needed.
      await runErpStockMigrations(tx);
      await tx`update erp_sync_state set cursor_value = now()`;
      await runErpStockMigrations(tx);
      const fresh = await tx<{ n: string }[]>`
        select count(*)::text as n from erp_sync_state where cursor_value is null`;
      expect(fresh[0]!.n).toBe("0");

      // Simulate a mirror created before WP-1.
      await tx.unsafe(`alter table erp_so_line drop column po_no cascade`);
      await tx.unsafe(`alter table erp_so_header drop column po_no cascade`);
      await tx`update erp_sync_state set cursor_value = now()`;

      await runErpStockMigrations(tx);

      const cols = await tx<{ table_name: string }[]>`
        select table_name from information_schema.columns
         where table_schema = ${schema} and column_name = 'po_no'
           and table_name in ('erp_so_header', 'erp_so_line')
         order by table_name`;
      expect(cols.map((c) => c.table_name)).toEqual(["erp_so_header", "erp_so_line"]);

      const reset = await tx<{ table_name: string }[]>`
        select table_name from erp_sync_state where cursor_value is null order by table_name`;
      expect(reset.map((r) => r.table_name)).toEqual(["so_header", "so_line"]);

      // The views came back (dropped by the cascade, recreated by the migration).
      const views = await tx<{ n: string }[]>`
        select count(*)::text as n from information_schema.views
         where table_schema = ${schema} and table_name = 'v_live_commitments'`;
      expect(views[0]!.n).toBe("1");

      // And a second boot is a no-op for the cursors.
      await tx`update erp_sync_state set cursor_value = now()`;
      await runErpStockMigrations(tx);
      const again = await tx<{ n: string }[]>`
        select count(*)::text as n from erp_sync_state where cursor_value is null`;
      expect(again[0]!.n).toBe("0");
    });
  }, 60_000);
});
