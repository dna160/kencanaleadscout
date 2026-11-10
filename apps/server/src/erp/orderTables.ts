/**
 * Kabar Pesanan WP-2 — the order-to-cash tables the order lane mirrors, beyond
 * the SO header/lines the stock sync already carries.
 *
 *   do_header         ← tbl_1082_SOLogisticPID           (DO / surat jalan)
 *   do_line           ← tbl_1205_SOSalesOrderDeliveryNID (DO lines)
 *   request_produksi  ← tbl_1236_DBRequestProduksiID     (production requests)
 *   sales             ← tbl_1130_CRMListSalesID          (reps, for the sales CC)
 *
 * Field meanings are the VERIFIED ones (docs/ontology/SELARAS-ONTOLOGY.md,
 * sweep 2026-11-10), including the traps:
 *   - 1082 `sj_date` is the SCHEDULED date; `delivery_date`, `received_date`,
 *     `driver`, `no_kendaraan` are never filled and are not mirrored.
 *   - 1236 `th_alu_skin` is labelled "Tebal" and holds the PANEL thickness;
 *     `alu` holds the skin. Mirrored as `th_panel` / `th_skin` so nobody has to
 *     remember that.
 *   - 1236 `approval_factory_manager` / `status_request` are dead (always
 *     "Waiting") and are not mirrored.
 *   - 1130 has no phone column today. If Selaras adds one, `phone` picks it up
 *     with no code change (PRD §9.4).
 *
 * Lookup columns store an ID; the API adds `<col>_label`. Where a human reads
 * the value (cara_kirim, cancel_order, so_ms…) the mirror keeps the label.
 *
 * Unlike the stock tables, a row the ERP marks deleted is KEPT with
 * `deleted_at` set: the event deriver (WP-3) needs to see a DO disappear to
 * cancel a pending "pengiriman dijadwalkan" message.
 *
 * Adapters never throw and return null for a row without a primary key.
 */
import { endpointOf, erpValue, type OrderTable } from "./selarasClient.js";

const { foldKeys, pick, asText, asNumber, asDateOnly, asTimestamp, pickUpdatedAt, pickDeletedAt, isRecord } = erpValue;

type Folded = Map<string, unknown>;

/** Every order-lane row carries these. */
export interface OrderRowBase {
  id: string;
  erp_created_at: Date | null;
  erp_updated_at: Date | null;
  deleted_at: Date | null;
}

export interface DoHeaderRow extends OrderRowBase {
  so_no: string | null;
  no_sj: string | null;
  /** YYYY-MM-DD — the scheduled date (DO created the day before in 90%). */
  sj_date: string | null;
  do_created_at: Date | null;
  /** Label, e.g. "di Antar" / "di Ambil". */
  cara_kirim: string | null;
  /** "Yes" on 0.7% of DOs. */
  cancel_order: string | null;
  print_status: string | null;
  top: string | null;
  top_days: number | null;
  due_date: string | null;
  invoice_no: string | null;
  customer_name_id: string | null;
  customer_name_text: string | null;
  total_lembar: number | null;
  total_m2: number | null;
}

export interface DoLineRow extends OrderRowBase {
  po_no: string | null;
  /** → tbl_1203 line id. */
  so_item_no: string | null;
  /** → tbl_1082 id (the DO header). */
  sj_id: string | null;
  do_text: string | null;
  sj_date: string | null;
  sn_fg: string | null;
  item_details: string | null;
  qty_delivered: number | null;
}

export interface RequestProduksiRow extends OrderRowBase {
  so_no: string | null;
  /** SO | MS (make-to-stock) | O | TRIAL. Only 'SO' rows are customer orders. */
  so_ms: string | null;
  wo_no: string | null;
  no_request: string | null;
  tanggal_request: string | null;
  brand: string | null;
  brand_text: string | null;
  warna: string | null;
  warna_text: string | null;
  /** Panel mm — read from 1236.th_alu_skin ("Tebal"). */
  th_panel: number | null;
  /** Skin — read from 1236.alu. */
  th_skin: number | null;
  qty_lembar: number | null;
}

export interface SalesRow extends OrderRowBase {
  sales_name: string | null;
  department: string | null;
  active: string | null;
  /** Null today: tbl_1130 has no phone column (verified). */
  phone: string | null;
}

export interface OrderRowByTable {
  do_header: DoHeaderRow;
  do_line: DoLineRow;
  request_produksi: RequestProduksiRow;
  sales: SalesRow;
}

/** Label first, then a persisted `_text` copy, then the raw value. */
function label(row: Folded, col: string): string | null {
  return asText(pick(row, `${col}_label`, `${col}_text`, col));
}

/** `{table}_id` is the documented primary key; `id` the fallback. */
export function orderPkField(table: OrderTable): string {
  return `${endpointOf(table)}_id`;
}

function base(table: OrderTable, row: Folded): OrderRowBase | null {
  const id = asText(pick(row, orderPkField(table), "id"));
  if (id === null) return null;
  return {
    id,
    erp_created_at: asTimestamp(pick(row, "created_at", "createdAt")),
    erp_updated_at: pickUpdatedAt(row),
    deleted_at: pickDeletedAt(row),
  };
}

function fold(raw: unknown): Folded | null {
  return isRecord(raw) ? foldKeys(raw) : null;
}

export function adaptDoHeaderRow(raw: unknown): DoHeaderRow | null {
  const row = fold(raw);
  const b = row && base("do_header", row);
  if (!row || !b) return null;
  return {
    ...b,
    so_no: asText(pick(row, "so_no")),
    no_sj: asText(pick(row, "no_sj")),
    sj_date: asDateOnly(pick(row, "sj_date")),
    do_created_at: asTimestamp(pick(row, "do_created_at")),
    cara_kirim: label(row, "cara_kirim"),
    cancel_order: label(row, "cancel_order"),
    print_status: label(row, "print_status"),
    top: label(row, "top"),
    top_days: asNumber(pick(row, "top_days")),
    due_date: asDateOnly(pick(row, "due_date")),
    invoice_no: asText(pick(row, "invoice_no")),
    customer_name_id: asText(pick(row, "customer_name")),
    customer_name_text: asText(pick(row, "customer_name_label", "customer_name_text")),
    total_lembar: asNumber(pick(row, "total_lembar")),
    total_m2: asNumber(pick(row, "total_m2")),
  };
}

export function adaptDoLineRow(raw: unknown): DoLineRow | null {
  const row = fold(raw);
  const b = row && base("do_line", row);
  if (!row || !b) return null;
  return {
    ...b,
    po_no: asText(pick(row, "po_no")),
    so_item_no: asText(pick(row, "so_item_no")),
    // Selaras calls the DO-header link `sj_no` on this table, but it holds the
    // 1082 row ID, not the surat-jalan number — hence `sj_id` in the mirror.
    sj_id: asText(pick(row, "sj_no")),
    do_text: asText(pick(row, "do_text")),
    sj_date: asDateOnly(pick(row, "sj_date")),
    sn_fg: label(row, "sn_fg"),
    item_details: asText(pick(row, "item_details")),
    qty_delivered: asNumber(pick(row, "qty_delivered")),
  };
}

export function adaptRequestProduksiRow(raw: unknown): RequestProduksiRow | null {
  const row = fold(raw);
  const b = row && base("request_produksi", row);
  if (!row || !b) return null;
  return {
    ...b,
    so_no: asText(pick(row, "so_no")),
    so_ms: label(row, "so_ms"),
    wo_no: asText(pick(row, "wo_no")),
    no_request: label(row, "no_request"),
    tanggal_request: asDateOnly(pick(row, "tanggal_request")),
    brand: asText(pick(row, "sticker")),
    brand_text: asText(pick(row, "sticker_label", "sticker_text")),
    warna: asText(pick(row, "warna")),
    warna_text: asText(pick(row, "warna_label", "warna_text")),
    th_panel: asNumber(pick(row, "th_alu_skin")),
    th_skin: asNumber(pick(row, "alu")),
    qty_lembar: asNumber(pick(row, "qty_lembar")),
  };
}

export function adaptSalesRow(raw: unknown): SalesRow | null {
  const row = fold(raw);
  const b = row && base("sales", row);
  if (!row || !b) return null;
  return {
    ...b,
    sales_name: asText(pick(row, "sales_name")),
    department: label(row, "department"),
    active: label(row, "active"),
    phone: asText(pick(row, "phone", "phone_number", "no_hp", "hp", "whatsapp", "no_wa", "telepon")),
  };
}

export const ORDER_ADAPTERS: { [K in OrderTable]: (raw: unknown) => OrderRowByTable[K] | null } = {
  do_header: adaptDoHeaderRow,
  do_line: adaptDoLineRow,
  request_produksi: adaptRequestProduksiRow,
  sales: adaptSalesRow,
};

// ── Upserts ──────────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySql = any;

/** The mirror table and the columns written, per order table (id first). */
export const ORDER_MIRROR: { [K in OrderTable]: { table: string; columns: readonly (keyof OrderRowByTable[K])[] } } = {
  do_header: {
    table: "erp_do_header",
    columns: [
      "id", "so_no", "no_sj", "sj_date", "do_created_at", "cara_kirim", "cancel_order", "print_status",
      "top", "top_days", "due_date", "invoice_no", "customer_name_id", "customer_name_text",
      "total_lembar", "total_m2", "erp_created_at", "erp_updated_at", "deleted_at",
    ],
  },
  do_line: {
    table: "erp_do_line",
    columns: [
      "id", "po_no", "so_item_no", "sj_id", "do_text", "sj_date", "sn_fg", "item_details", "qty_delivered",
      "erp_created_at", "erp_updated_at", "deleted_at",
    ],
  },
  request_produksi: {
    table: "erp_request_produksi",
    columns: [
      "id", "so_no", "so_ms", "wo_no", "no_request", "tanggal_request", "brand", "brand_text", "warna",
      "warna_text", "th_panel", "th_skin", "qty_lembar", "erp_created_at", "erp_updated_at", "deleted_at",
    ],
  },
  sales: {
    table: "erp_sales",
    columns: ["id", "sales_name", "department", "active", "phone", "erp_created_at", "erp_updated_at", "deleted_at"],
  },
};

/**
 * Idempotent upsert by ERP primary key. Last row wins within a batch (a page
 * can carry the same id twice when it straddles an update).
 */
export async function upsertOrderRows<K extends OrderTable>(
  tx: AnySql,
  table: K,
  rows: readonly OrderRowByTable[K][],
): Promise<number> {
  if (rows.length === 0) return 0;
  const byId = new Map<string, OrderRowByTable[K]>();
  for (const r of rows) byId.set(r.id, r);
  const batch = [...byId.values()];
  const { table: name, columns } = ORDER_MIRROR[table];
  const cols = columns as readonly string[];
  const updates = cols
    .filter((c) => c !== "id")
    .map((c) => `${c} = excluded.${c}`)
    .concat("synced_at = now()")
    .join(", ");
  await tx`
    insert into ${tx(name)} ${tx(batch as any, ...cols)}
    on conflict (id) do update set ${tx.unsafe(updates)}
  `;
  return batch.length;
}
