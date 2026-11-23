/**
 * Kabar Pesanan — read-only lookup of ONE SO straight from the Selaras API, so
 * the /notify test pipeline can render the three messages from a real order.
 *
 * Why not the mirror: the current mirror carries neither the recipient fields
 * (penerima / kontak_penerima), nor the DO header (tbl_1082), nor Request
 * Produksi (tbl_1236). Those mirrors arrive with WP-2 (PRD §6, §14). Until
 * then, four GETs per lookup is negligible load, and it is a human clicking a
 * button, never a loop.
 *
 * Field meanings are the verified ones from docs/ontology/SELARAS-ONTOLOGY.md:
 *  - 1202: po_no = SO number; penerima/kontak_penerima = recipient; status_order.
 *  - 1203: th_alu_skin = skin (0.10…); total_thickness_acp = panel mm.
 *  - 1236: th_alu_skin is labelled "Tebal" and holds PANEL mm; `alu` holds skin.
 *  - 1082: sj_date = scheduled date; cara_kirim "di Ambil" = pickup.
 *
 * The test pipeline NEVER sends to the ERP phone. It only reports it, masked,
 * so the tester can see who would receive the message in live mode.
 */
import { config, hasErp, hasErpCredentials } from "../config.js";
import { redactSecrets } from "../erp/selarasClient.js";
import type { ItemLine, OrderContext } from "./messages.js";

export interface LookupResult {
  context: OrderContext;
  /** Masked ERP recipient phone (live-mode destination), e.g. "0812-****-4455". */
  erpRecipientPhoneMasked: string | null;
  /** Finance approval on the SO header (`approval_new`): step 1 waits for it in live mode. */
  approval: string | null;
  hasDeliveryOrder: boolean;
  paymentTerm: string | null;
  statusOrder: string | null;
}

export class ErpLookupError extends Error {
  constructor(public statusCode: number, message: string) {
    super(message);
  }
}

export const erpLookupAvailable = (): boolean => hasErp && hasErpCredentials;

type Row = Record<string, unknown>;
type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const t = (v: unknown): string => (v == null ? "" : String(v).trim());
const n = (v: unknown): number => {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
};
/** Prefer the API's resolved label, then a persisted _text copy, then the raw value. */
const label = (r: Row, col: string): string => t(r[`${col}_label`]) || t(r[`${col}_text`]) || t(r[col]);

export function maskPhone(raw: string | null | undefined): string | null {
  const digits = t(raw).split(/[\/&,]/)[0]!.replace(/\D/g, "");
  if (digits.length < 6) return null;
  return `${digits.slice(0, 4)}-****-${digits.slice(-4)}`;
}

function fmtThickness(v: unknown): string {
  const x = n(v);
  return x ? String(Number(x.toFixed(2))) : "";
}

export function soLineItem(r: Row): ItemLine {
  const panel = fmtThickness(r["total_thickness_acp"]);
  const skin = fmtThickness(r["th_alu_skin"]);
  const spec = [panel && `${panel}mm`, skin].filter(Boolean).join(" / ");
  return {
    label: [label(r, "brand"), label(r, "warna"), spec].filter(Boolean).join(" "),
    qty: n(r["qty_order"]),
    parts: { product: label(r, "brand") || null, spec, colour: label(r, "warna") || null },
  };
}

export async function lookupOrder(
  soNo: string,
  opts: { salesWa: string | null; salesNameOverride: string | null; fetchImpl?: FetchLike },
): Promise<LookupResult> {
  if (!erpLookupAvailable()) throw new ErpLookupError(503, "ERP tidak terhubung; gunakan contoh pesanan.");
  const fetchImpl = opts.fetchImpl ?? fetch;

  const get = async (table: string, params: Record<string, string>): Promise<Row[]> => {
    const qs = new URLSearchParams(params);
    const headers: Record<string, string> = { accept: "application/json" };
    if (config.selarasAuthMode === "query") {
      qs.set(config.selarasKeyParam, config.selarasSecretKey);
      qs.set(config.selarasTokenParam, config.selarasSecretToken);
    } else if (config.selarasAuthMode === "header") {
      headers[config.selarasKeyHeader.toLowerCase()] = config.selarasSecretKey;
      headers[config.selarasTokenHeader.toLowerCase()] = config.selarasSecretToken;
    } else if (config.selarasToken) {
      headers["authorization"] = `Bearer ${config.selarasToken}`;
    }
    const url = `${config.selarasBaseUrl.replace(/\/+$/, "")}/table/${table}?${qs.toString()}`;
    let res: Response;
    try {
      res = await fetchImpl(url, { method: "GET", headers, signal: AbortSignal.timeout(config.selarasTimeoutMs) });
    } catch (err) {
      throw new ErpLookupError(502, `ERP tidak terjangkau: ${redactSecrets(err)}`);
    }
    if (!res.ok) throw new ErpLookupError(502, `ERP menjawab HTTP ${res.status} untuk ${table}.`);
    const body = (await res.json().catch(() => null)) as { data?: Row[] } | null;
    return Array.isArray(body?.data) ? body!.data : [];
  };

  const [header] = await get("tbl_1202_SOSalesOrderNID", {
    po_no: soNo,
    limit: "1",
    fields:
      "po_no,po_date,customer_name,customer_name_text,penerima,kontak_penerima,alamat_kirim,sales_name,sales_name_text,top_limit,status_order,approval_new",
  });
  if (!header) throw new ErpLookupError(404, `SO ${soNo} tidak ditemukan di Selaras.`);

  const lines = await get("tbl_1203_SOSalesOrderDetailNID", {
    po_no: soNo,
    limit: "200",
    fields: "brand,brand_text,warna,warna_text,th_alu_skin,total_thickness_acp,qty_order",
  });
  const dos = (
    await get("tbl_1082_SOLogisticPID", {
      so_no: soNo,
      limit: "20",
      order_by: "created_at",
      order_dir: "desc",
      fields: "so_no,no_sj,sj_date,cara_kirim,cancel_order,do_created_at",
    })
  ).filter((r) => label(r, "cancel_order").toLowerCase() !== "yes");

  const latestDo = dos[0];
  const statusOrder = label(header, "status_order") || null;
  const context: OrderContext = {
    soNo: t(header["po_no"]) || soNo,
    customerName: label(header, "customer_name") || "Pelanggan",
    recipientName: t(header["penerima"]) || null,
    items: lines.map(soLineItem),
    salesName: opts.salesNameOverride || label(header, "sales_name") || null,
    salesWa: opts.salesWa,
    delivery: latestDo
      ? {
          sjNo: t(latestDo["no_sj"]),
          sjDate: t(latestDo["sj_date"]).slice(0, 10),
          pickup: /ambil/i.test(label(latestDo, "cara_kirim")),
          address: t(header["alamat_kirim"]) || null,
          partial: dos.length > 1 || /half/i.test(statusOrder ?? ""),
        }
      : null,
    source: "erp",
  };

  return {
    context,
    erpRecipientPhoneMasked: maskPhone(t(header["kontak_penerima"])),
    approval: label(header, "approval_new") || null,
    hasDeliveryOrder: dos.length > 0,
    paymentTerm: label(header, "top_limit") || null,
    statusOrder,
  };
}
