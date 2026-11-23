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
  "delivery_scheduled",
  "delivery_today",
  "delivery_departed",
  "delivery_changed",
] as const;
export type Milestone = (typeof MILESTONES)[number];

export function isMilestone(v: unknown): v is Milestone {
  return typeof v === "string" && (MILESTONES as readonly string[]).includes(v);
}

export interface ItemLine {
  /** e.g. "ALCOPAN GLOSSY WHITE 4mm / 0.21" */
  label: string;
  qty: number;
  /**
   * The same item split up, when known: the confirmation lists items as
   * "{produk} {tebal} {warna}" (PRD §21.1). `spec` is "4mm / 0.21" (panel mm,
   * then the aluminium skin), already corrected for the 1203 column names.
   */
  parts?: { product: string | null; spec: string; colour: string | null };
}

export interface OrderContext {
  soNo: string;
  customerName: string;
  /** Person who receives the goods (`tbl_1202.penerima`), used in the greeting. */
  recipientName: string | null;
  items: ItemLine[];
  salesName: string | null;
  salesWa: string | null;
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
export const TEMPLATE_VERSION = "2026-11-23.1";

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

/** "ALCOPAN 4mm / 0.21 GLOSSY WHITE": product, thickness, colour (PRD §21.1). */
export function confirmLabel(i: ItemLine): string {
  if (!i.parts) return i.label;
  return [i.parts.product, i.parts.spec, i.parts.colour].filter((x) => x && x.trim()).join(" ") || i.label;
}

/** Numbered list for the confirmation: up to `max` lines, then "+N item lainnya". */
export function formatItemsNumbered(items: ItemLine[], max = 15): string {
  if (items.length === 0) return "(rincian barang menyusul)";
  const shown = items.slice(0, max).map((i, n) => `${n + 1}. ${confirmLabel(i)}, ${fmtQty(i.qty)} lembar`);
  const rest = items.length - max;
  if (rest > 0) shown.push(`+${rest} item lainnya`);
  return shown.join("\n");
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
   * delivery_changed only. `from`: the date the customer was last given (null
   * when no date was known); `to`: the new date (null = not yet known).
   * `told`: false when the customer never received the step-3 schedule for
   * this DO, so the message gives the full delivery details instead.
   */
  change?: { from: string | null; to: string | null; told: boolean };
  /** delivery_departed: what the warehouse filled in XTable (PRD §21.3); each shown only if filled. */
  departure?: { vehicle: string | null; driver: string | null };
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
    // Sent on Finance approval (PRD §21.1). "Dikonfirmasi", never "dibayar":
    // COD and Tempo orders have not paid yet.
    parts.push(`Pesanan Anda nomor *${ctx.soNo}* sudah kami konfirmasi dan saat ini sedang kami proses.`);
    parts.push(`Item yang dipesan:\n${formatItemsNumbered(ctx.items)}`);
    parts.push("Kami akan mengabari Anda kembali saat jadwal pengiriman sudah ditetapkan.");
  } else if (m === "delivery_changed" || (m === "delivery_scheduled" && opts.change)) {
    const d = ctx.delivery;
    const change = opts.change ?? { from: d?.sjDate ?? null, to: d?.sjDate ? addDaysIso(d.sjDate, 1) : null, told: true };
    parts.push(...deliveryChanged(ctx, change));
  } else if (m === "delivery_today") {
    // PRD §21.3 interim, at 08:00 on the delivery day. Says when, never that the truck has left.
    const d = ctx.delivery;
    if (!d) throw new Error("delivery_today needs ctx.delivery");
    parts.push(`Pesanan *${ctx.soNo}* dijadwalkan dikirim hari ini.`);
    const lines = [`No. surat jalan: ${d.sjNo}`];
    if (d.address) lines.push(`Alamat kirim: ${d.address}`);
    parts.push(lines.join("\n"));
  } else if (m === "delivery_departed") {
    const d = ctx.delivery;
    if (!d) throw new Error("delivery_departed needs ctx.delivery");
    parts.push(`Pesanan *${ctx.soNo}* sedang dalam perjalanan ke alamat Anda.`);
    const lines = [`No. surat jalan: ${d.sjNo}`];
    const truck = [
      opts.departure?.vehicle ? `Kendaraan: ${opts.departure.vehicle}` : null,
      opts.departure?.driver ? `Sopir: ${opts.departure.driver}` : null,
    ].filter(Boolean).join(" · ");
    if (truck) lines.push(truck);
    if (d.address) lines.push(`Alamat kirim: ${d.address}`);
    parts.push(lines.join("\n"));
    parts.push(`Barang:\n${formatItems(ctx.items)}`);
    if (d.partial) parts.push("Ini pengiriman sebagian; sisa pesanan menyusul.");
    parts.push("Mohon periksa kondisi dan jumlah barang saat diterima.");
  } else {
    const d = ctx.delivery;
    if (!d) throw new Error("delivery_scheduled needs ctx.delivery");
    const lead = `Pesanan *${ctx.soNo}*`;
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
 * Appendix C (NOTIFY_HOLD_MV1_MIN / _MV3_MIN = 10 / 0).
 */
export const MILESTONE_INFO: Record<
  Milestone,
  { step: number; label: string; labelEn: string; trigger: string; hold: string; coverage: string; notes: string }
> = {
  so_received: {
    step: 1,
    label: "Pesanan dikonfirmasi",
    labelEn: "SO confirmed",
    trigger:
      "Finance approves the SO (tbl_1202 approval_new = Approved), or a live Delivery Order appears first while approval is still Waiting (164 CBD SOs shipped unapproved in the sweep). Whichever comes first; once per SO.",
    hold: "10 minutes (configurable to 0). The step-3 message for the same SO always waits until this one has gone out (+60 s).",
    coverage: "Every non-excluded SO created after the switch-over (2026-11-23). SOs already told under the old 'diterima' trigger are not told again.",
    notes:
      "CBD, COD and Tempo alike. Wording says 'dikonfirmasi', never 'dibayar': payment status lives in Accurate, not Selaras.",
  },
  delivery_scheduled: {
    step: 2,
    label: "1 · Dijadwalkan",
    labelEn: "Delivery scheduled",
    trigger:
      "A new Delivery Order (tbl_1082_SOLogisticPID) for this so_no, cancel_order = No. The scheduled date is sj_date (the DO is created the day before in 90% of cases).",
    hold: "None by default (configurable). Cancelled if the DO is cancelled before dispatch.",
    coverage:
      "One message per surat jalan (97% of SOs have exactly one DO). cara_kirim = 'di Ambil' (24%) uses the 'siap diambil' wording.",
    notes:
      "delivery_date, driver, no_kendaraan and received_date are never filled in the ERP, so they are never used.",
  },
  delivery_today: {
    step: 3,
    label: "Dikirim hari ini (08:00)",
    labelEn: "Delivery today (interim)",
    trigger:
      "At 08:00 WIB on the delivery day, for every live 'di Antar' DO due today that has not departed yet. The interim until the warehouse fills the vehicle / driver in XTable (PRD §21.3). Switch in Konfigurasi → Sumber 'Sedang dikirim'.",
    hold: "None. Re-checked at send time: skipped if the DO is cancelled, its date moved, it already departed, or a reschedule request is open.",
    coverage: "Deliveries due today. Never says the truck has left.",
    notes: "No rep CC.",
  },
  delivery_departed: {
    step: 4,
    label: "2 · Sedang dikirim",
    labelEn: "Goods dispatched",
    trigger:
      "In XTable, the warehouse fills no_kendaraan, driver or delivery_date on a live 'di Antar' DO (tbl_1082) as the truck leaves. Once per DO. The ERP had no other departure signal (PRD §21.3).",
    hold: "None. Filled after the delivery day = recorded, not sent; a message still waiting at the end of its day is dropped.",
    coverage: "Deliveries (cara_kirim 'di Antar'). Pickups never get it.",
    notes:
      "Shows the vehicle and driver when filled. No rep CC. An unfilled delivery never messages the customer: Sales Admin and the warehouse get a 13:00 reminder instead.",
  },
  delivery_changed: {
    step: 5,
    label: "Jadwal berubah",
    labelEn: "Delivery rescheduled",
    trigger:
      "The DO's sj_date is edited in XTable, or staff mark 'Tunda' on the Pengiriman tab (new date, or date not yet known).",
    hold: "None. Only the latest Tunda mark is sent: a mark undone or replaced before sending is cancelled.",
    coverage:
      "Any DO the customer was given a date for. If the step-1 delivery message was never sent, this one gives the full delivery details instead.",
    notes: "The rep gets a CC.",
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
      { label: "ALCOPAN GLOSSY WHITE 4mm / 0.21", qty: 10, parts: { product: "ALCOPAN", spec: "4mm / 0.21", colour: "GLOSSY WHITE" } },
      { label: "TAJIMA PRIME LIGHT SILVER 3mm / 0.10", qty: 25, parts: { product: "TAJIMA PRIME", spec: "3mm / 0.10", colour: "LIGHT SILVER" } },
    ],
    salesName,
    salesWa,
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

/** To Sales Admin / the warehouse: today's surat jalan with no departure recorded in XTable. */
export function renderDispatchReminder(
  dateIso: string,
  rows: { sjNo: string; soNo: string; customer: string }[],
  shadow: boolean,
): string {
  const max = 25;
  const lines = rows.slice(0, max).map((r) => `• ${r.sjNo} — ${r.soNo} — ${r.customer}`);
  if (rows.length > max) lines.push(`• dan ${rows.length - max} lainnya`);
  return [
    `${shadow ? "[SHADOW] " : ""}⏰ *Kabar Pesanan* — Pengiriman belum tercatat berangkat`,
    `Surat jalan berikut dijadwalkan dikirim hari ini (${formatDateId(dateIso)}), tetapi No. kendaraan / sopir belum diisi di XTable:`,
    lines.join("\n"),
    "Pelanggan belum menerima kabar \"sedang dikirim\". Bila truk sudah berangkat, mohon isi No. kendaraan dan sopir pada DO di XTable. Bila jadwalnya bergeser, ubah tanggal DO di XTable atau tandai Tunda di LeadScout › Kabar Pesanan › Pengiriman.",
  ].join("\n\n");
}

/** To the rep and Sales Admin: a customer asked to move a delivery and nobody has answered (PRD §21.5). */
export function renderHoldReminder(customer: string, sjNo: string, current: string | null, requested: string | null, shadow: boolean): string {
  return [
    `${shadow ? "[SHADOW] " : ""}⏰ *Kabar Pesanan* — Permintaan ubah jadwal ${customer} · DO ${sjNo} belum ditindaklanjuti`,
    `Jadwal sekarang: ${current ? formatDateId(current) : "belum pasti"} · diminta: ${requested ? formatDateId(requested) : "tidak disebut"}.`,
    "Pesan jadwal untuk DO ini ditahan sampai ada keputusan. Ubah tanggal DO di XTable (atau tandai Tunda di LeadScout), atau pilih \"Tetap sesuai jadwal\" di Kabar Pesanan › Pesan, lalu kabari pelanggan.",
  ].join("\n\n");
}
