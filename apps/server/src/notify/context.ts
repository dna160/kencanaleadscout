/**
 * Kabar Pesanan WP-4 — build a message's OrderContext from the ERP MIRROR.
 *
 * The live path's counterpart of erpLookup.ts (which reads Selaras directly
 * for the test pipeline). Read at SEND time, never at plan time: a phone
 * corrected after the event, a DO cancelled during the hold, an SO deleted in
 * the first ten minutes — the message reflects the mirror as it is now.
 */
import { normalizeNumber } from "@kencana/core";
import type { Sql } from "../db/client.js";
import type { ItemLine, OrderContext } from "./messages.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySql = Sql | any;

export interface LiveHeader {
  id: string;
  po_no: string;
  customer_name_id: string | null;
  customer_final_id: string | null;
  customer_name_text: string | null;
  sales_name_id: string | null;
  sales_name_text: string | null;
  penerima: string | null;
  kontak_penerima: string | null;
  alamat_kirim: string | null;
  status_order: string | null;
}

export interface LiveDo {
  id: string;
  so_no: string | null;
  no_sj: string | null;
  sj_date: string | null;
  cara_kirim: string | null;
  cancel_order: string | null;
  deleted: boolean;
}

export interface Rep {
  erpSalesId: string | null;
  name: string | null;
  phone: string | null;
  ccEnabled: boolean;
}

export interface LiveOrder {
  header: LiveHeader;
  rep: Rep;
  ctx: OrderContext;
  doRow: LiveDo | null;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function thick(v: unknown): string {
  const n = num(v);
  return n ? String(Number(n.toFixed(2))) : "";
}
/** "ALCOPAN GLOSSY WHITE 4mm / 0.21" — the same shape as the test pipeline. */
export function itemLabel(brand: string | null, warna: string | null, panel: unknown, skin: unknown): string {
  const p = thick(panel);
  const s = thick(skin);
  const spec = [p && `${p}mm`, s].filter(Boolean).join(" / ");
  return [brand, warna, spec].filter(Boolean).join(" ");
}

export async function loadHeader(db: AnySql, soNo: string): Promise<LiveHeader | null> {
  const [h] = await db<LiveHeader[]>`
    select id, po_no, customer_name_id, customer_final_id, customer_name_text, sales_name_id, sales_name_text,
           penerima, kontak_penerima, alamat_kirim, status_order
      from erp_so_header where po_no = ${soNo}
     order by erp_updated_at desc nulls last, id desc limit 1
  `;
  return h ?? null;
}

export async function loadDo(db: AnySql, doId: string): Promise<LiveDo | null> {
  const [d] = await db<LiveDo[]>`
    select id, so_no, no_sj, to_char(sj_date, 'YYYY-MM-DD') as sj_date, cara_kirim, cancel_order,
           deleted_at is not null as deleted
      from erp_do_header where id = ${doId}
  `;
  return d ?? null;
}

export async function loadRep(db: AnySql, h: Pick<LiveHeader, "sales_name_id" | "sales_name_text">): Promise<Rep> {
  if (!h.sales_name_id) return { erpSalesId: null, name: h.sales_name_text, phone: null, ccEnabled: false };
  const [r] = await db<{ es_name: string | null; es_phone: string | null; nc_name: string | null; nc_phone: string | null; cc_enabled: boolean | null }[]>`
    select es.sales_name as es_name, es.phone as es_phone,
           nc.sales_name as nc_name, nc.phone_e164 as nc_phone, nc.cc_enabled
      from (select ${h.sales_name_id}::text as id) k
      left join erp_sales es on es.id = k.id
      left join notify_sales_contacts nc on nc.erp_sales_id = k.id
  `;
  // A phone stored in Selaras wins once it exists (PRD §9.4 end state).
  const phone = (r?.es_phone && normalizeNumber(r.es_phone)) || r?.nc_phone || null;
  return {
    erpSalesId: h.sales_name_id,
    name: r?.es_name ?? h.sales_name_text ?? r?.nc_name ?? null,
    phone,
    ccEnabled: r?.cc_enabled ?? true,
  };
}

async function soItems(db: AnySql, soNo: string): Promise<ItemLine[]> {
  const rows = await db<{ brand: string | null; warna: string | null; th_panel: unknown; th: unknown; qty: unknown }[]>`
    select coalesce(l.brand_text, l.brand) as brand, coalesce(l.warna_text, w.rm_warna, l.warna) as warna,
           l.th_panel, l.th, l.qty_order as qty
      from erp_so_line l
      left join lateral (select rm_warna from erp_warna w where w.code = l.warna or w.id = l.warna limit 1) w on true
     where l.po_no = ${soNo}
     order by l.id
  `;
  return rows.map((r: { brand: string | null; warna: string | null; th_panel: unknown; th: unknown; qty: unknown }) => ({
    label: itemLabel(r.brand, r.warna, r.th_panel, r.th),
    qty: num(r.qty),
  }));
}

async function productionItems(db: AnySql, soNo: string): Promise<{ woNo: string | null; items: ItemLine[] } | null> {
  const rows = await db<{ wo_no: string | null; brand: string | null; warna: string | null; th_panel: unknown; th_skin: unknown; qty: unknown }[]>`
    select wo_no, coalesce(brand_text, brand) as brand, coalesce(warna_text, warna) as warna, th_panel, th_skin,
           qty_lembar as qty
      from erp_request_produksi
     where so_no = ${soNo} and upper(coalesce(so_ms, '')) = 'SO' and deleted_at is null
     order by id
  `;
  if (!rows.length) return null;
  return {
    woNo: rows[0]!.wo_no,
    items: rows.map((r: { brand: string | null; warna: string | null; th_panel: unknown; th_skin: unknown; qty: unknown }) => ({
      label: itemLabel(r.brand, r.warna, r.th_panel, r.th_skin),
      qty: num(r.qty),
    })),
  };
}

/** What THIS DO carries (1205 joined to the SO line for its product), else the SO's items. */
async function doItems(db: AnySql, doId: string): Promise<ItemLine[]> {
  const rows = await db<{ brand: string | null; warna: string | null; th_panel: unknown; th: unknown; qty: unknown; details: string | null }[]>`
    select coalesce(l.brand_text, l.brand) as brand, coalesce(l.warna_text, l.warna) as warna, l.th_panel, l.th,
           dl.qty_delivered as qty, dl.item_details as details
      from erp_do_line dl
      left join erp_so_line l on l.id = dl.so_item_no
     where dl.sj_id = ${doId} and dl.deleted_at is null
     order by dl.id
  `;
  return rows.map((r: { brand: string | null; warna: string | null; th_panel: unknown; th: unknown; qty: unknown; details: string | null }) => ({
    label: r.brand || r.warna ? itemLabel(r.brand, r.warna, r.th_panel, r.th) : r.details ?? "(item)",
    qty: num(r.qty),
  }));
}

/** "+6281311112222" → "0813-1111-2222". */
export function localDisplay(e164: string): string {
  const local = e164.replace(/^\+62/, "0");
  return local.length >= 10 ? `${local.slice(0, 4)}-${local.slice(4, 8)}-${local.slice(8)}` : local;
}

/**
 * Everything a message needs, or null when the SO is gone from the mirror
 * (deleted upstream during the hold — the message must not go out).
 */
export async function loadLiveOrder(db: AnySql, soNo: string, doId: string | null): Promise<LiveOrder | null> {
  const header = await loadHeader(db, soNo);
  if (!header) return null;
  const rep = await loadRep(db, header);
  const items = await soItems(db, soNo);
  const production = await productionItems(db, soNo);

  let doRow: LiveDo | null = null;
  let delivery: OrderContext["delivery"] = null;
  let deliveryItems: ItemLine[] = [];
  if (doId) {
    doRow = await loadDo(db, doId);
    if (doRow) {
      const [{ n } = { n: 0 }] = await db<{ n: number }[]>`
        select count(*)::int as n from erp_do_header
         where so_no = ${soNo} and deleted_at is null and lower(coalesce(cancel_order, '')) <> 'yes'
      `;
      delivery = {
        sjNo: doRow.no_sj ?? doRow.id,
        sjDate: doRow.sj_date ?? "",
        pickup: /ambil/i.test(doRow.cara_kirim ?? ""),
        address: header.alamat_kirim,
        partial: n > 1 || /half/i.test(header.status_order ?? ""),
      };
      deliveryItems = await doItems(db, doId);
    }
  }

  const ctx: OrderContext = {
    soNo,
    customerName: header.customer_name_text ?? "Pelanggan",
    recipientName: header.penerima,
    items: deliveryItems.length ? deliveryItems : items,
    salesName: rep.name,
    salesWa: rep.phone ? localDisplay(rep.phone) : null,
    production,
    delivery,
    source: "erp",
  };
  return { header, rep, ctx, doRow };
}
