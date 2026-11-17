/**
 * Kabar Pesanan — message catalogue for the three MVP milestones.
 *
 * Pure functions only: no I/O, no clock reads except where a caller passes a
 * date in. The same renderers serve the /notify test pipeline today and the live
 * milestone deriver later, so what a tester sees is exactly what a customer gets.
 *
 * Rules (PRD docs/customer-notifications/PRD.md §8 / Appendix B):
 *  - Bahasa Indonesia, WhatsApp formatting (*bold*, _italic_).
 *  - NO payment, approval or price language in any MVP message.
 *  - Never promise a date the ERP did not give: the delivery date is the DO's
 *    own `sj_date`; production messages carry no date at all.
 *  - Every message ends with the STOP footer.
 */

export const MILESTONES = [
  "so_received",
  "production_started",
  "delivery_scheduled",
  "delivery_changed",
  "delivery_departed",
] as const;
export type Milestone = (typeof MILESTONES)[number];

export function isMilestone(v: unknown): v is Milestone {
  return typeof v === "string" && (MILESTONES as readonly string[]).includes(v);
}

export interface ItemLine {
  /** e.g. "ALCOPAN GLOSSY WHITE 4mm / 0.21" */
  label: string;
  qty: number;
}

export interface OrderContext {
  soNo: string;
  customerName: string;
  /** Person who receives the goods (`tbl_1202.penerima`), used in the greeting. */
  recipientName: string | null;
  items: ItemLine[];
  salesName: string | null;
  salesWa: string | null;
  production: {
    woNo: string | null;
    items: ItemLine[];
  } | null;
  delivery: {
    sjNo: string;
    /** YYYY-MM-DD, the DO's `sj_date` (scheduled date). */
    sjDate: string;
    pickup: boolean;
    address: string | null;
    /** True when the SO has more than one DO, or this DO does not carry everything. */
    partial: boolean;
  } | null;
  source: "erp" | "sample";
}

/**
 * Recorded on every ledger row (PRD §8). Bump when wording changes, so a
 * complaint about a message can be traced to the exact template that sent it.
 */
export const TEMPLATE_VERSION = "2026-11-17.1";

export const FOOTER = "_Balas STOP untuk berhenti menerima notifikasi pesanan._";
export const SIGNATURE = "— PT Kencana Panelindo";

const DAYS = ["Minggu", "Senin", "Selasa", "Rabu", "Kamis", "Jumat", "Sabtu"];
const MONTHS = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

/** "2026-11-11" → "Rabu, 11 November 2026". Unparseable input is returned as-is. */
export function formatDateId(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (Number.isNaN(date.getTime()) || mo < 1 || mo > 12) return iso;
  return `${DAYS[date.getUTCDay()]}, ${d} ${MONTHS[mo - 1]} ${y}`;
}

function fmtQty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toLocaleString("id-ID", { maximumFractionDigits: 2 });
}

/** Bullet list, at most `max` lines, then "dan N item lainnya". */
export function formatItems(items: ItemLine[], max = 3): string {
  if (items.length === 0) return "• (rincian barang menyusul)";
  const shown = items.slice(0, max).map((i) => `• ${i.label} × ${fmtQty(i.qty)} lembar`);
  const rest = items.length - max;
  if (rest > 0) shown.push(`• dan ${rest} item lainnya`);
  return shown.join("\n");
}

function greeting(ctx: OrderContext): string {
  const who = ctx.recipientName?.trim() || ctx.customerName.trim();
  return `Halo Bapak/Ibu ${who},`;
}

function salesLine(ctx: OrderContext): string | null {
  if (!ctx.salesName && !ctx.salesWa) return null;
  const name = ctx.salesName ?? "sales kami";
  return ctx.salesWa
    ? `Untuk pertanyaan, silakan hubungi sales Anda, ${name} (${ctx.salesWa}).`
    : `Untuk pertanyaan, silakan hubungi sales Anda, ${name}.`;
}

const INTRO =
  "Ini adalah nomor resmi notifikasi pesanan PT Kencana Panelindo. " +
  "Melalui nomor ini kami akan menginformasikan perkembangan pesanan Anda.";

export interface RenderOptions {
  /** Prepend the one-time introduction (first message ever sent to this number). */
  introduce?: boolean;
  /**
   * Step 3 only: the SO's "received" message never went out because the DO
   * arrived while it was still on hold, so this one says both (PRD §7 MV1 merge).
   */
  mergedReceived?: boolean;
  /**
   * delivery_changed only. `from`: the date the customer was last given (null
   * when no date was known); `to`: the new date (null = not yet known).
   * `told`: false when the customer never received the step-3 schedule for
   * this DO, so the message gives the full delivery details instead.
   */
  change?: { from: string | null; to: string | null; told: boolean };
}

/** "2026-11-11" + n days, as YYYY-MM-DD. */
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return new Date(d.getTime() + n * 86_400_000).toISOString().slice(0, 10);
}

function deliveryChanged(ctx: OrderContext, change: NonNullable<RenderOptions["change"]>): string[] {
  const d = ctx.delivery;
  if (!d) throw new Error("delivery_changed needs ctx.delivery");
  const what = d.pickup ? "pengambilan" : "pengiriman";
  const doLabel = d.pickup ? "No. DO" : "No. surat jalan";
  const { from, to, told } = change;
  const out: string[] = [];
  if (!told || !from) {
    // The customer has no date for this DO yet: give it now, in full.
    if (to) {
      out.push(
        d.pickup
          ? `Pesanan *${ctx.soNo}* siap diambil mulai ${formatDateId(to)} (${doLabel} ${d.sjNo}).`
          : `Jadwal pengiriman pesanan *${ctx.soNo}* sudah ditetapkan.`,
      );
      if (!d.pickup) out.push([`${doLabel}: ${d.sjNo}`, `Jadwal pengiriman: ${formatDateId(to)}`, ...(d.address ? [`Alamat kirim: ${d.address}`] : [])].join("\n"));
    } else {
      out.push(`Pesanan *${ctx.soNo}* sedang kami siapkan untuk ${d.pickup ? "diambil" : "dikirim"} (${doLabel} ${d.sjNo}).`);
      out.push(`Jadwal ${what} akan kami kabarkan kembali.`);
    }
    out.push(`Barang:\n${formatItems(ctx.items)}`);
    return out;
  }
  if (to && to < from) {
    out.push(`Jadwal ${what} pesanan *${ctx.soNo}* berubah menjadi lebih awal.`);
    out.push([`${doLabel}: ${d.sjNo}`, `Jadwal sebelumnya: ${formatDateId(from)}`, `Jadwal baru: ${formatDateId(to)}`].join("\n"));
    return out;
  }
  out.push(`Mohon maaf, ${what} pesanan *${ctx.soNo}* yang dijadwalkan ${formatDateId(from)} *tertunda*.`);
  out.push(
    to
      ? [`${doLabel}: ${d.sjNo}`, `Jadwal baru: ${formatDateId(to)}`].join("\n")
      : `${doLabel}: ${d.sjNo}\nJadwal ${what} yang baru akan kami kabarkan kembali.`,
  );
  out.push("Mohon maaf atas ketidaknyamanannya.");
  return out;
}

/** The message the customer receives. */
export function renderCustomerMessage(m: Milestone, ctx: OrderContext, opts: RenderOptions = {}): string {
  const parts: string[] = [greeting(ctx)];
  if (opts.introduce) parts.push(INTRO);

  if (m === "so_received") {
    parts.push(`Pesanan Anda nomor *${ctx.soNo}* telah kami terima dan sedang diproses.`);
    parts.push(`Ringkasan:\n${formatItems(ctx.items)}`);
  } else if (m === "production_started") {
    const items = ctx.production?.items.length ? ctx.production.items : ctx.items;
    parts.push(`Pesanan *${ctx.soNo}* saat ini sedang diproduksi di pabrik kami.`);
    parts.push(`Item:\n${formatItems(items)}`);
    parts.push("Kami akan mengabari Anda kembali saat jadwal pengiriman sudah ditetapkan.");
  } else if (m === "delivery_changed") {
    const d = ctx.delivery;
    const change = opts.change ?? { from: d?.sjDate ?? null, to: d?.sjDate ? addDaysIso(d.sjDate, 1) : null, told: true };
    parts.push(...deliveryChanged(ctx, change));
  } else if (m === "delivery_departed") {
    const d = ctx.delivery;
    if (!d) throw new Error("delivery_departed needs ctx.delivery");
    parts.push(`Pesanan *${ctx.soNo}* sedang dalam perjalanan ke alamat Anda hari ini.`);
    const lines = [`No. surat jalan: ${d.sjNo}`];
    if (d.address) lines.push(`Alamat kirim: ${d.address}`);
    parts.push(lines.join("\n"));
    parts.push(`Barang:\n${formatItems(ctx.items)}`);
    if (d.partial) parts.push("Ini pengiriman sebagian; sisa pesanan menyusul.");
    parts.push("Mohon periksa kondisi dan jumlah barang saat diterima.");
  } else {
    const d = ctx.delivery;
    if (!d) throw new Error("delivery_scheduled needs ctx.delivery");
    const lead = opts.mergedReceived
      ? `Pesanan Anda nomor *${ctx.soNo}* telah kami terima dan`
      : `Pesanan *${ctx.soNo}*`;
    if (d.pickup) {
      parts.push(`${lead} sudah siap diambil mulai ${formatDateId(d.sjDate)} (No. DO ${d.sjNo}).`);
      parts.push(`Barang:\n${formatItems(ctx.items)}`);
      parts.push("Silakan koordinasikan waktu pengambilan dengan sales Anda.");
    } else {
      parts.push(`${lead} telah dijadwalkan untuk dikirim.`);
      const lines = [`No. surat jalan: ${d.sjNo}`, `Jadwal pengiriman: ${formatDateId(d.sjDate)}`];
      if (d.address) lines.push(`Alamat kirim: ${d.address}`);
      parts.push(lines.join("\n"));
      parts.push(`Barang:\n${formatItems(ctx.items)}`);
      if (d.partial) parts.push("Ini pengiriman sebagian; sisa pesanan menyusul.");
      parts.push("Mohon periksa kondisi dan jumlah barang saat diterima.");
    }
  }

  const sl = salesLine(ctx);
  if (sl) parts.push(sl);
  parts.push(SIGNATURE);
  parts.push(FOOTER);
  return parts.join("\n\n");
}

/** The copy the sales rep receives: who it went to, then the exact customer text. */
export function renderSalesCc(
  m: Milestone,
  ctx: OrderContext,
  customerNumber: string,
  customerText: string,
  /** Shown above the copy, e.g. that the customer could NOT be reached. */
  warning?: string,
): string {
  return [
    `📋 *Salinan Kabar Pesanan* — ${MILESTONE_INFO[m].label}`,
    ...(warning ? [`⚠️ ${warning}`] : []),
    `Pelanggan: ${ctx.customerName} (${customerNumber})\nSO: ${ctx.soNo}`,
    "— Pesan yang dikirim ke pelanggan —",
    customerText,
  ].join("\n\n");
}

/**
 * Human-readable trigger rules, shown on /notify so the tester can see exactly
 * what fires each message in live mode. Source: docs/ontology/SELARAS-ONTOLOGY.md
 * (verified sweep 2026-11-10) and PRD §5.0 / §7. Hold defaults follow PRD
 * Appendix C (NOTIFY_HOLD_MV1_MIN / _MV2_MIN / _MV3_MIN = 10 / 0 / 0).
 */
export const MILESTONE_INFO: Record<
  Milestone,
  { step: number; label: string; labelEn: string; trigger: string; hold: string; coverage: string; notes: string }
> = {
  so_received: {
    step: 1,
    label: "Pesanan diterima",
    labelEn: "SO received",
    trigger:
      "A new SO header appears in Selaras (tbl_1202_SOSalesOrderNID, keyed on po_no) and is not deleted or cancelled. Detected by the 60 s fast poll (or a Selaras webhook once available).",
    hold: "10 minutes (configurable to 0). Absorbs SOs deleted or edited right after entry. If a DO for the SO is pending at release, this merges with step 3.",
    coverage: "Every SO (~1,300/month). Marketplace SOs (tbl_1368) and related parties are excluded.",
    notes:
      "No approval or payment logic in the MVP; 'diproses' stays true even while Finance approval is still Waiting.",
  },
  production_started: {
    step: 2,
    label: "Mulai produksi",
    labelEn: "Production started",
    trigger:
      "A Request Produksi row (tbl_1236) with so_ms = 'SO' and so_no = this SO. The WO number comes from wo_no.",
    hold: "None by default (configurable).",
    coverage:
      "Only make-to-order SOs, ~4% of SOs (109 of 2,636 in 60 days). Stock-served orders skip this step.",
    notes:
      "Do not use approval_factory_manager / status_request (always 'Waiting'). Optional follow-up later: tbl_1190 status_automatic = Done.",
  },
  delivery_scheduled: {
    step: 3,
    label: "Pengiriman dijadwalkan",
    labelEn: "Delivery scheduled",
    trigger:
      "A new Delivery Order (tbl_1082_SOLogisticPID) for this so_no, cancel_order = No. The scheduled date is sj_date (the DO is created the day before in 90% of cases).",
    hold: "None by default (configurable). Cancelled if the DO is cancelled before dispatch.",
    coverage:
      "One message per surat jalan (97% of SOs have exactly one DO). cara_kirim = 'di Ambil' (24%) uses the 'siap diambil' wording.",
    notes:
      "delivery_date, driver, no_kendaraan and received_date are never filled in the ERP, so they are never used.",
  },
  delivery_changed: {
    step: 4,
    label: "Jadwal kirim berubah",
    labelEn: "Delivery delayed / rescheduled",
    trigger:
      "Staff mark a surat jalan 'Ditunda' on the Pengiriman tab (new date, or date not yet known), or the DO's sj_date is edited in Selaras.",
    hold: "None. Only the latest mark is sent: a mark undone or replaced before sending is cancelled.",
    coverage:
      "Any DO the customer was given a date for. If the step-3 message was never sent, this one gives the full delivery details instead.",
    notes:
      "Selaras never edited sj_date in 3,000 tracked DOs (Nov 2026), so staff marks are the main source. The rep gets a CC.",
  },
  delivery_departed: {
    step: 5,
    label: "Barang dikirim",
    labelEn: "Goods dispatched",
    trigger:
      "Staff mark a surat jalan 'Berangkat' on the Pengiriman tab, on its delivery day. The ERP has no dispatch signal (print_status is set the afternoon before, and a third of DOs are never printed).",
    hold: "None. Sent only on the day it was marked; a message still waiting at the end of that day is dropped.",
    coverage: "Delivered orders (cara_kirim 'di Antar'). Pickups are not on the list.",
    notes:
      "No rep CC (the rep sees it in Pesan / Riwayat). An unmarked delivery never messages the customer: staff get a reminder in the afternoon instead.",
  },
};

/** Sample order used when no SO number is given or the ERP is not connected. */
export function sampleContext(today: Date, salesName: string | null, salesWa: string | null): OrderContext {
  const tomorrow = new Date(today.getTime() + 24 * 3600 * 1000);
  const ymd = (d: Date) => d.toISOString().slice(0, 10);
  const yy = String(today.getUTCFullYear()).slice(2);
  const mm = String(today.getUTCMonth() + 1);
  return {
    soNo: `SO.${yy}/UJI-0001`,
    customerName: "TOKO CONTOH JAYA",
    recipientName: "Budi",
    items: [
      { label: "ALCOPAN GLOSSY WHITE 4mm / 0.21", qty: 10 },
      { label: "TAJIMA PRIME LIGHT SILVER 3mm / 0.10", qty: 25 },
    ],
    salesName,
    salesWa,
    production: { woNo: `WO.${yy}/UJI`, items: [{ label: "ALCOPAN GLOSSY WHITE 4mm / 0.21", qty: 10 }] },
    delivery: { sjNo: `KP/DO-UJI/${mm}/${yy}`, sjDate: ymd(tomorrow), pickup: false, address: null, partial: false },
    source: "sample",
  };
}

/**
 * Shadow mode (PRD §13 Phase 1): the rep receives the exact customer text,
 * plus what live mode would have done with it, so they can grade it.
 */
export function renderShadow(m: Milestone, soNo: string, verdict: string, customerText: string): string {
  return [
    `[SHADOW] 📋 *Kabar Pesanan* — ${MILESTONE_INFO[m].label} · SO ${soNo}`,
    `Mode uji: pesan ini HANYA dikirim ke Anda. ${verdict}`,
    "— Pesan untuk pelanggan —",
    customerText,
    "_Mohon nilai: apakah pesan ini benar? Balas BENAR atau SALAH + alasannya._",
  ].join("\n\n");
}

/**
 * To the rep only: a DO was cancelled in Selaras AFTER the customer was told it
 * was scheduled (PRD §7 do.cancelled). The customer is not messaged again
 * automatically; the rep decides what to say.
 */
export function renderDoCancelledNotice(soNo: string, sjNo: string, customerName: string, shadow: boolean): string {
  return [
    `${shadow ? "[SHADOW] " : ""}⚠️ *Kabar Pesanan* — DO dibatalkan`,
    `DO ${sjNo} untuk SO ${soNo} (${customerName}) dibatalkan di Selaras setelah pesan jadwal pengiriman ${
      shadow ? "(mode uji) dibuat" : "terkirim ke pelanggan"
    }.`,
    "Pelanggan tidak menerima pesan otomatis lanjutan. Mohon informasikan pelanggan bila perlu.",
  ].join("\n\n");
}

/** To the rep / logistics admin: today's surat jalan nobody has marked yet. */
export function renderDispatchReminder(
  dateIso: string,
  rows: { sjNo: string; soNo: string; customer: string }[],
  shadow: boolean,
): string {
  const max = 25;
  const lines = rows.slice(0, max).map((r) => `• ${r.sjNo} — ${r.soNo} — ${r.customer}`);
  if (rows.length > max) lines.push(`• dan ${rows.length - max} lainnya`);
  return [
    `${shadow ? "[SHADOW] " : ""}⏰ *Kabar Pesanan* — Pengiriman belum ditandai`,
    `Surat jalan berikut dijadwalkan dikirim hari ini (${formatDateId(dateIso)}), tetapi belum ditandai *Berangkat* atau *Ditunda*:`,
    lines.join("\n"),
    "Pelanggan belum menerima kabar pengiriman. Mohon pastikan statusnya ditandai di LeadScout › Kabar Pesanan › Pengiriman.",
  ].join("\n\n");
}
