/**
 * Kabar Pesanan WP-3 — the PURE core of the event deriver (PRD §5.1, §7).
 *
 * Mirror rows in, event drafts out. No I/O, no clock. Every draft carries a
 * deterministic `event_key`, so deriving the same rows twice yields the same
 * keys and the store's `on conflict (event_key) do nothing` makes replays free.
 *
 *   so.confirmed          SO approved by Finance (approval_new) OR a    key so.confirmed:{po_no}
 *                         live DO appears first (PRD §21.1); whichever
 *                         comes first, SOs from before the switch-over excluded
 *   do.created            1082 row, not cancelled, not deleted           key do.created:{no_sj|id}
 *   do.cancelled          1082 row with cancel_order = Yes, or deleted   key do.cancelled:{no_sj|id}
 *   do.departed           live 'di Antar' DO whose no_kendaraan, driver   key do.departed:{do id}
 *                         or delivery_date got filled (PRD §21.3)
 *   so.late               live SO lines whose ETA has passed             key so.late:{po_no}:{earliest eta}
 *
 * Production (1236) is no longer an event (PRD §21.2); the table stays mirrored.
 * `so.created` / `production.requested` rows from before 2026-11-23 stay in the
 * log as history and are no longer planned.
 *
 * Payloads hold business facts for display and routing, never phone numbers:
 * consumers that need the recipient read it from the mirror at send time, so a
 * corrected phone is used rather than one frozen into an event.
 */

export type EventType =
  | "so.confirmed"
  | "do.created"
  | "do.cancelled"
  | "so.late"
  | "do.rescheduled" // staff mark or Selaras sj_date edit (notify/dispatch.ts)
  | "do.departed"; // XTable departure fields (here), or an old staff mark (before 2026-11-23)
export type EventSource = "erp-mirror" | "erp-webhook" | "manual";

export interface EventDraft {
  event_key: string;
  event_type: EventType;
  so_no: string | null;
  subject_ref: string | null;
  occurred_at: Date | null;
  payload: Record<string, unknown>;
}

/** The mirror columns the deriver reads (a subset of erp_so_header). */
export interface HeaderFacts {
  id: string;
  po_no: string | null;
  po_date: string | null;
  status_order: string | null;
  customer_name_id: string | null;
  customer_name_text: string | null;
  customer_final_id: string | null;
  sales_name_id: string | null;
  sales_name_text: string | null;
  top_limit: string | null;
  approval_new: string | null;
  erp_created_at: Date | null;
  erp_updated_at: Date | null;
}

export interface DoFacts {
  id: string;
  so_no: string | null;
  no_sj: string | null;
  sj_date: string | null;
  do_created_at: Date | null;
  cara_kirim: string | null;
  cancel_order: string | null;
  erp_created_at: Date | null;
  erp_updated_at: Date | null;
  deleted_at: Date | null;
  /** The DO's SO header, when mirrored (for the DO-first confirmation, §21.1 b). */
  so_found?: boolean | null;
  /** Filled by the warehouse as the truck leaves (PRD §21.3). */
  driver?: string | null;
  no_kendaraan?: string | null;
  delivery_date?: Date | null;
  so_status?: string | null;
  so_created_at?: Date | null;
}

export interface LateFacts {
  po_no: string;
  /** YYYY-MM-DD, the earliest passed ETA among the SO's live lines. */
  earliest_eta: string;
  lines: number;
  balance: number;
}

export interface DeriveOptions {
  /** SO `status_order` values that mean cancelled (same list as the stock views). */
  cancelledStatuses: readonly string[];
  /**
   * The switch-over to approval-based confirmations (a real instant). SOs
   * created before it never get one: they were handled under the old trigger.
   * Null = no baseline (tests of the pure rules).
   */
  confirmedSince?: Date | null;
}

const WIB_MS = 7 * 3_600_000;

/** Header created before the switch-over? Mirror timestamps are WIB digits stored as UTC (A18). */
function beforeSwitchOver(createdAt: Date | null | undefined, opts: DeriveOptions): boolean {
  if (!opts.confirmedSince || !createdAt) return false;
  return createdAt.getTime() - WIB_MS < opts.confirmedSince.getTime();
}

export function isApproved(approval: string | null | undefined): boolean {
  return (approval ?? "").trim().toLowerCase() === "approved";
}

const norm = (s: string | null | undefined): string => (s ?? "").trim().toLowerCase();

export function isCancelledStatus(status: string | null, opts: DeriveOptions): boolean {
  const s = norm(status);
  return s !== "" && opts.cancelledStatuses.some((c) => norm(c) === s);
}

export function isDoCancelled(d: Pick<DoFacts, "cancel_order">): boolean {
  return norm(d.cancel_order) === "yes";
}

export function isPickup(caraKirim: string | null): boolean {
  return /ambil/i.test(caraKirim ?? "");
}

/** (a) Finance approved the SO: the normal path to the confirmation message. */
export function deriveFromHeader(h: HeaderFacts, opts: DeriveOptions): EventDraft[] {
  const poNo = h.po_no?.trim();
  if (!poNo) return []; // no SO number ⇒ nothing can key or route it
  if (isCancelledStatus(h.status_order, opts)) return [];
  if (!isApproved(h.approval_new)) return [];
  if (beforeSwitchOver(h.erp_created_at, opts)) return [];
  return [
    {
      event_key: `so.confirmed:${poNo}`,
      event_type: "so.confirmed",
      so_no: poNo,
      subject_ref: h.id,
      // The approval is the movement, so its age is measured from the last edit.
      occurred_at: h.erp_updated_at ?? h.erp_created_at,
      payload: {
        via: "approval",
        header_id: h.id,
        po_date: h.po_date,
        customer_name_id: h.customer_name_id,
        customer_name: h.customer_name_text,
        // customer_final ≠ customer_name is the distributor direct-ship case (PRD §7 exclusions).
        customer_final_id: h.customer_final_id,
        sales_name_id: h.sales_name_id,
        sales_name: h.sales_name_text,
        top_limit: h.top_limit,
      },
    },
  ];
}

export function deriveFromDo(d: DoFacts, opts: DeriveOptions = { cancelledStatuses: [] }): EventDraft[] {
  const ref = d.no_sj?.trim() || `id-${d.id}`;
  const soNo = d.so_no?.trim() || null;
  const payload = {
    do_id: d.id,
    no_sj: d.no_sj,
    sj_date: d.sj_date,
    cara_kirim: d.cara_kirim,
    pickup: isPickup(d.cara_kirim),
  };
  if (d.deleted_at || isDoCancelled(d)) {
    return [
      {
        event_key: `do.cancelled:${ref}`,
        event_type: "do.cancelled",
        so_no: soNo,
        subject_ref: ref,
        occurred_at: d.deleted_at ?? d.erp_updated_at,
        payload: { ...payload, reason: d.deleted_at ? "deleted" : "cancel_order" },
      },
    ];
  }
  if (!soNo) return []; // a DO that names no SO cannot be routed to anyone
  const out: EventDraft[] = [];
  // (b) A live DO before Finance approval (164 CBD SOs shipped while still
  // "Waiting"): confirm first, so "dijadwalkan" never arrives unannounced.
  // Same key as the approval path, so whichever comes first is the one.
  if (d.so_found && !isCancelledStatus(d.so_status ?? null, opts) && !beforeSwitchOver(d.so_created_at, opts)) {
    out.push({
      event_key: `so.confirmed:${soNo}`,
      event_type: "so.confirmed",
      so_no: soNo,
      subject_ref: d.id,
      occurred_at: d.do_created_at ?? d.erp_created_at,
      payload: { via: "do", do_id: d.id, no_sj: d.no_sj },
    });
  }
  out.push(
    {
      event_key: `do.created:${ref}`,
      event_type: "do.created",
      so_no: soNo,
      subject_ref: ref,
      occurred_at: d.do_created_at ?? d.erp_created_at,
      payload,
    },
  );
  const departure = deriveDeparture(d, soNo);
  if (departure) out.push(departure);
  return out;
}

const filled = (v: string | null | undefined): boolean => Boolean(v && v.trim() && v.trim() !== "-");

/**
 * Step 2 "sedang dikirim" (PRD §21.3): the warehouse fills the vehicle, the
 * driver or the delivery date on a live delivery DO as the truck leaves. Once
 * per DO (later edits keep the same key). Filled after the delivery day =
 * a backfill: recorded, never sent. Pickups never depart.
 */
export function deriveDeparture(d: DoFacts, soNo: string): EventDraft | null {
  if (isPickup(d.cara_kirim)) return null;
  if (!filled(d.no_kendaraan) && !filled(d.driver) && !d.delivery_date) return null;
  // The mirror's updated_at holds WIB wall-clock digits, so its UTC date is the WIB day.
  const seenOn = (d.erp_updated_at ?? d.erp_created_at)?.toISOString().slice(0, 10) ?? null;
  return {
    event_key: `do.departed:${d.id}`,
    event_type: "do.departed",
    so_no: soNo,
    subject_ref: d.no_sj?.trim() || `id-${d.id}`,
    occurred_at: d.erp_updated_at,
    payload: {
      do_id: d.id,
      no_sj: d.no_sj,
      sj_date: d.sj_date,
      no_kendaraan: filled(d.no_kendaraan) ? d.no_kendaraan!.trim() : null,
      driver: filled(d.driver) ? d.driver!.trim() : null,
      delivery_date: d.delivery_date ? d.delivery_date.toISOString() : null,
      source: "xtable",
      marked_on: seenOn,
      backfill: Boolean(seenOn && d.sj_date && seenOn > d.sj_date),
    },
  };
}

export function deriveLate(l: LateFacts): EventDraft {
  return {
    // Keyed on the ETA: a further slip (the earliest passed ETA moves) is a new fact.
    event_key: `so.late:${l.po_no}:${l.earliest_eta}`,
    event_type: "so.late",
    so_no: l.po_no,
    subject_ref: l.earliest_eta,
    occurred_at: null,
    payload: { earliest_eta: l.earliest_eta, lines: l.lines, balance: l.balance },
  };
}

export interface DeriveInput {
  headers?: readonly HeaderFacts[];
  dos?: readonly DoFacts[];
  late?: readonly LateFacts[];
}

/** All drafts for a batch, de-duplicated by key (first wins). */
export function deriveEvents(input: DeriveInput, opts: DeriveOptions): EventDraft[] {
  const out = new Map<string, EventDraft>();
  const add = (drafts: EventDraft[]) => {
    for (const d of drafts) if (!out.has(d.event_key)) out.set(d.event_key, d);
  };
  for (const h of input.headers ?? []) add(deriveFromHeader(h, opts));
  for (const d of input.dos ?? []) add(deriveFromDo(d, opts));
  for (const l of input.late ?? []) add([deriveLate(l)]);
  return [...out.values()];
}
