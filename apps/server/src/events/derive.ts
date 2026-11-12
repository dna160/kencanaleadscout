/**
 * Kabar Pesanan WP-3 — the PURE core of the event deriver (PRD §5.1, §7).
 *
 * Mirror rows in, event drafts out. No I/O, no clock. Every draft carries a
 * deterministic `event_key`, so deriving the same rows twice yields the same
 * keys and the store's `on conflict (event_key) do nothing` makes replays free.
 *
 *   so.created            new SO header (po_no), not cancelled          key so.created:{po_no}
 *   production.requested  1236 row with so_ms = 'SO' and an SO number   key production.requested:{so_no}:{wo_no|request id}
 *   do.created            1082 row, not cancelled, not deleted           key do.created:{no_sj|id}
 *   do.cancelled          1082 row with cancel_order = Yes, or deleted   key do.cancelled:{no_sj|id}
 *   so.late               live SO lines whose ETA has passed             key so.late:{po_no}:{earliest eta}
 *
 * Payloads hold business facts for display and routing, never phone numbers:
 * consumers that need the recipient read it from the mirror at send time, so a
 * corrected phone is used rather than one frozen into an event.
 */

export type EventType = "so.created" | "production.requested" | "do.created" | "do.cancelled" | "so.late";
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
  erp_created_at: Date | null;
}

export interface RequestFacts {
  id: string;
  so_no: string | null;
  so_ms: string | null;
  wo_no: string | null;
  no_request: string | null;
  tanggal_request: string | null;
  erp_created_at: Date | null;
  deleted_at: Date | null;
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

export function deriveFromHeader(h: HeaderFacts, opts: DeriveOptions): EventDraft[] {
  const poNo = h.po_no?.trim();
  if (!poNo) return []; // no SO number ⇒ nothing can key or route it
  if (isCancelledStatus(h.status_order, opts)) return [];
  return [
    {
      event_key: `so.created:${poNo}`,
      event_type: "so.created",
      so_no: poNo,
      subject_ref: h.id,
      occurred_at: h.erp_created_at,
      payload: {
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

export function deriveFromRequest(r: RequestFacts): EventDraft[] {
  const soNo = r.so_no?.trim();
  if (!soNo || r.deleted_at) return [];
  if (norm(r.so_ms) !== "so") return []; // MS / O / TRIAL are make-to-stock, not a customer order
  const wo = r.wo_no?.trim() || null;
  return [
    {
      event_key: `production.requested:${soNo}:${wo ?? `req-${r.id}`}`,
      event_type: "production.requested",
      so_no: soNo,
      subject_ref: r.id,
      occurred_at: r.erp_created_at,
      payload: { request_id: r.id, wo_no: wo, no_request: r.no_request, tanggal_request: r.tanggal_request },
    },
  ];
}

export function deriveFromDo(d: DoFacts): EventDraft[] {
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
  return [
    {
      event_key: `do.created:${ref}`,
      event_type: "do.created",
      so_no: soNo,
      subject_ref: ref,
      occurred_at: d.do_created_at ?? d.erp_created_at,
      payload,
    },
  ];
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
  requests?: readonly RequestFacts[];
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
  for (const r of input.requests ?? []) add(deriveFromRequest(r));
  for (const d of input.dos ?? []) add(deriveFromDo(d));
  for (const l of input.late ?? []) add([deriveLate(l)]);
  return [...out.values()];
}
