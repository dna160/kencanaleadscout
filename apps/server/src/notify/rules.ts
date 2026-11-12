/**
 * Kabar Pesanan WP-4 — the PURE notification policy (PRD §7, §9).
 *
 * No I/O and no clock reads: every function takes what it needs. The planner
 * and dispatcher (dispatcher.ts) do the I/O and call these, so each rule is
 * testable on its own.
 */
import { normalizeNumber } from "@kencana/core";
import type { Milestone } from "./messages.js";

export type LiveMode = "off" | "shadow" | "on";
export type Role = "customer" | "sales_cc";

/** Which event type starts which customer message. */
export const EVENT_MILESTONE: Record<string, Milestone> = {
  "so.created": "so_received",
  "production.requested": "production_started",
  "do.created": "delivery_scheduled",
};

/** Internal rep-only notice (not a customer milestone). */
export const DO_CANCELLED_NOTICE = "do_cancelled_notice";

/**
 * One outbox row per (mode, milestone, subject, role). The subject is the SO
 * for steps 1–2 and the DO for step 3 (one message per surat jalan). Mode is in
 * the key so a shadow run never blocks the live message for the same order.
 */
export function outboxKey(mode: LiveMode, milestone: string, subject: string, role: Role): string {
  return `notify:${mode}:${milestone}:${subject}:${role}`;
}

// ── Recipients (PRD §9.1) ────────────────────────────────────────────────────

/**
 * `kontak_penerima` as typed into the SO: one number, or two joined by "/",
 * "&", "," or ";" (~5% of SOs), or nothing. Returns every Indonesian mobile in
 * order, normalized to E.164; landlines and junk are dropped.
 */
export function parseRecipientPhones(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(/[\/&,;]|\s{2,}|\bdan\b/i)) {
    const n = normalizeNumber(part.trim());
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export interface RecipientResolution {
  phone: string | null;
  source: "override" | "kontak_penerima" | null;
  alternates: string[];
}

/**
 * Override first, then the SO's own `kontak_penerima`. The PRD's further
 * fallbacks (1055 PIC via buyer_name, 1054 phone) are not mirrored yet, so a
 * missing number is `unreachable` and the rep is told.
 */
export function resolveRecipient(overridePhone: string | null, kontakPenerima: string | null): RecipientResolution {
  const o = overridePhone ? normalizeNumber(overridePhone) : null;
  if (o) return { phone: o, source: "override", alternates: [] };
  const phones = parseRecipientPhones(kontakPenerima);
  if (phones.length) return { phone: phones[0]!, source: "kontak_penerima", alternates: phones.slice(1) };
  return { phone: null, source: null, alternates: [] };
}

/** "+6281283114455" → "0812-****-4455": how the shadow verdict names a customer. */
export function maskE164(e164: string | null): string {
  if (!e164) return "(tanpa nomor)";
  const local = e164.replace(/^\+62/, "0");
  return `${local.slice(0, 4)}-****-${local.slice(-4)}`;
}

// ── Exclusions (PRD §7) ──────────────────────────────────────────────────────

/** Whole-word, case-insensitive: "KMI" excludes "PT KMI" but not "SKMI JAYA". */
export function isExcludedCustomer(name: string | null, excluded: readonly string[]): boolean {
  if (!name) return false;
  return excluded.some((x) => {
    const esc = x.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return esc !== "" && new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "iu").test(name);
  });
}

/**
 * Distributor direct-ship: the SO is billed to one customer and delivered for
 * another. The recipient on the SO is then the END customer, who does not know
 * the distributor buys from Kencana. Suppressed until OQ-3 settles a policy.
 */
export function isDirectShip(customerId: string | null, customerFinalId: string | null): boolean {
  return Boolean(customerId && customerFinalId && customerId !== customerFinalId);
}

// ── Time (WIB) ───────────────────────────────────────────────────────────────

const WIB_MS = 7 * 3_600_000;

/** WIB hour (0–23) of a real instant. */
export function wibHour(now: Date): number {
  return new Date(now.getTime() + WIB_MS).getUTCHours();
}

/** Start of the WIB calendar day containing `now`, as a real instant. */
export function wibDayStart(now: Date): Date {
  const w = new Date(now.getTime() + WIB_MS);
  return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - WIB_MS);
}

/**
 * Null when `now` is inside the sending window [fromHour, untilHour) WIB;
 * otherwise the next instant the window opens.
 */
export function nextSendWindow(now: Date, fromHour: number, untilHour: number): Date | null {
  const h = wibHour(now);
  if (h >= fromHour && h < untilHour) return null;
  const today = wibDayStart(now);
  const opensToday = new Date(today.getTime() + fromHour * 3_600_000);
  return h < fromHour ? opensToday : new Date(opensToday.getTime() + 86_400_000);
}

/**
 * Event age on the ERP's own clock. Mirrored ERP timestamps hold WIB
 * wall-clock digits stored as UTC (selarasClient A18), so they are shifted
 * back by 7 h before comparing with a real instant.
 */
export function erpAgeHours(occurredAt: Date | null, now: Date): number | null {
  if (!occurredAt) return null;
  return (now.getTime() - (occurredAt.getTime() - WIB_MS)) / 3_600_000;
}

/** Default hold for a milestone, in minutes (PRD §5.0). */
export function holdFor(milestone: Milestone, holds: Record<Milestone, number>): number {
  return Math.max(0, holds[milestone] ?? 0);
}
