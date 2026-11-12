/**
 * Kabar Pesanan WP-5 — what LeadScout does with gateway callbacks (PRD §9.3,
 * §10.2, §10.5).
 *
 *   receipt   → the ledger row with that provider_message_id: sent / delivered
 *               / read / failed.
 *   inbound   → STOP/BERHENTI opts the number out (and says so once); MULAI
 *               opts back in; a rep's BENAR/SALAH grades their latest [SHADOW]
 *               message; any other customer reply is forwarded to the SO's rep,
 *               with at most one auto-reply per 24 h naming that rep.
 *   state     → logged_out / temporary_ban / disconnected / connected recorded
 *               on notify_settings (the dispatcher already pauses on health).
 *
 * Every message LeadScout sends from here is recorded in notify_ledger too.
 */
import { randomUUID } from "node:crypto";
import { normalizeNumber } from "@kencana/core";
import type { Sql } from "../db/client.js";
import type { Channel } from "./channel.js";
import { loadHeader, loadRep, localDisplay } from "./context.js";
import { TEMPLATE_VERSION } from "./messages.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnySql = Sql | any;

export interface GatewayEvent {
  type: string;
  message_id?: string;
  status?: string;
  error?: string;
  from_pn?: string;
  from_lid?: string;
  text?: string;
  code?: number;
  expires_seconds?: number;
  ts?: string;
}

const STOP_RE = /^\s*(stop|berhenti|unsubscribe)\b/i;
const START_RE = /^\s*(mulai|start|subscribe)\b/i;
const GRADE_RE = /^\s*(benar|salah)\b[\s:,.-]*(.*)$/is;

export const STOP_ACK =
  "Baik, nomor ini tidak akan menerima notifikasi pesanan dari PT Kencana Panelindo lagi. " +
  "Balas MULAI kapan saja untuk mengaktifkannya kembali.";
export const START_ACK = "Notifikasi pesanan PT Kencana Panelindo telah diaktifkan kembali untuk nomor ini.";

export function autoReplyText(repName: string | null, repWa: string | null): string {
  const who = repName ? `sales Anda, ${repName}${repWa ? ` (${repWa})` : ""}` : "sales Anda";
  return (
    "Terima kasih atas pesan Anda. Nomor ini khusus untuk notifikasi pesanan dan tidak dipantau. " +
    `Pesan Anda sudah kami teruskan ke ${who}.`
  );
}

export function forwardText(customer: string, phone: string, soNo: string, text: string): string {
  return [`💬 *Balasan pelanggan* — ${customer} (${localDisplay(phone)}) · SO ${soNo}`, text].join("\n\n");
}

async function recordSend(
  db: AnySql,
  ch: Channel,
  o: { milestone: string; soNo: string | null; role: "customer" | "sales_cc"; to: string; body: string },
): Promise<void> {
  const key = `system:${o.milestone}:${o.to}:${randomUUID()}`;
  const r = await ch.send({ to: o.to, text: o.body, idempotencyKey: key });
  await db`
    insert into notify_ledger (mode, milestone, so_no, recipient_role, to_number, body, channel, status,
                               provider_message_id, error, context_source, idempotency_key, template_version, sent_at)
    values ('live', ${o.milestone}, ${o.soNo}, ${o.role}, ${o.to}, ${o.body}, ${ch.mode}, ${r.status},
            ${r.providerMessageId}, ${r.error}, 'inbound', ${key}, ${TEMPLATE_VERSION},
            ${["sent", "queued", "stubbed"].includes(r.status) ? new Date() : null})
  `;
}

// ── receipts ─────────────────────────────────────────────────────────────────

export async function applyReceipt(db: AnySql, e: GatewayEvent): Promise<number> {
  if (!e.message_id) return 0;
  const at = e.ts ? new Date(e.ts) : new Date();
  switch (e.status) {
    case "server_ack":
      return (await db`
        update notify_ledger set status = 'sent', sent_at = coalesce(sent_at, ${at})
         where provider_message_id = ${e.message_id} and status in ('queued', 'sent')
        returning id`).length;
    case "delivered":
      return (await db`
        update notify_ledger set status = 'sent', delivered_at = coalesce(delivered_at, ${at})
         where provider_message_id = ${e.message_id} returning id`).length;
    case "read":
      return (await db`
        update notify_ledger set status = 'sent', read_at = coalesce(read_at, ${at}),
               delivered_at = coalesce(delivered_at, ${at})
         where provider_message_id = ${e.message_id} returning id`).length;
    case "failed":
      return (await db`
        update notify_ledger set status = 'failed', error = ${e.error ?? "gateway failed"}, sent_at = null
         where provider_message_id = ${e.message_id} returning id`).length;
    default:
      return 0;
  }
}

// ── state ────────────────────────────────────────────────────────────────────

export async function applyState(db: AnySql, e: GatewayEvent): Promise<void> {
  const detail =
    e.type === "temporary_ban"
      ? `code ${e.code ?? "?"}, expires in ${e.expires_seconds ?? "?"} s`
      : e.error ?? e.text ?? (e.code !== undefined ? `code ${e.code}` : null);
  await db`
    update notify_settings set gateway_state = ${e.type}, gateway_detail = ${detail}, gateway_state_at = now()
     where id = 1
  `;
}

// ── inbound ──────────────────────────────────────────────────────────────────

/** Phone numbers of every rep LeadScout knows (the CC list, plus Selaras once it has them). */
async function repPhones(db: AnySql): Promise<Set<string>> {
  const rows = await db<{ phone: string | null }[]>`
    select phone_e164 as phone from notify_sales_contacts where phone_e164 is not null
    union all
    select phone from erp_sales where phone is not null and deleted_at is null
  `;
  const out = new Set<string>();
  for (const r of rows) {
    const n = r.phone && (r.phone.startsWith("+") ? r.phone : normalizeNumber(r.phone));
    if (n) out.add(n);
  }
  return out;
}

export interface InboundResult {
  action: string;
  phone: string | null;
  soNo?: string | null;
}

export async function handleInbound(db: AnySql, ch: Channel, e: GatewayEvent, now = new Date()): Promise<InboundResult> {
  const text = (e.text ?? "").trim();
  let phone = e.from_pn ? normalizeNumber(e.from_pn) : null;
  if (!phone && e.from_lid) {
    const [c] = await db<{ phone_e164: string }[]>`select phone_e164 from notify_contacts where lid = ${e.from_lid} limit 1`;
    phone = c?.phone_e164 ?? null;
  }
  if (phone && e.from_lid) {
    // Learn the LID↔PN pair for the next LID-only message (PRD §10.3).
    await db`
      insert into notify_contacts (phone_e164, lid) values (${phone}, ${e.from_lid})
      on conflict (phone_e164) do update set lid = excluded.lid, updated_at = now()
    `;
  }

  const inserted = await db<{ id: string }[]>`
    insert into notify_inbound (message_id, from_pn, from_lid, text, received_at)
    values (${e.message_id ?? null}, ${phone}, ${e.from_lid ?? null}, ${text}, ${now})
    on conflict (message_id) do nothing
    returning id::text
  `;
  if (!inserted.length) return { action: "duplicate", phone };
  const inboundId = inserted[0]!.id;
  const done = async (action: string, soNo: string | null = null): Promise<InboundResult> => {
    await db`update notify_inbound set action = ${action}, so_no = ${soNo} where id = ${inboundId}`;
    return { action, phone, soNo };
  };

  if (!phone) return done("unresolved"); // LID with no known number: kept, nothing sent

  if (STOP_RE.test(text)) {
    await db`
      insert into notify_contacts (phone_e164, consent_state, consent_source, opted_out_at)
      values (${phone}, 'opted_out', 'reply:STOP', ${now})
      on conflict (phone_e164) do update set consent_state = 'opted_out', consent_source = 'reply:STOP',
             opted_out_at = ${now}, updated_at = now()
    `;
    await recordSend(db, ch, { milestone: "stop_ack", soNo: null, role: "customer", to: phone, body: STOP_ACK });
    return done("opted_out");
  }
  if (START_RE.test(text)) {
    await db`
      insert into notify_contacts (phone_e164, consent_state, consent_source)
      values (${phone}, 'explicit', 'reply:MULAI')
      on conflict (phone_e164) do update set consent_state = 'explicit', consent_source = 'reply:MULAI',
             opted_out_at = null, updated_at = now()
    `;
    await recordSend(db, ch, { milestone: "start_ack", soNo: null, role: "customer", to: phone, body: START_ACK });
    return done("opted_in");
  }

  const grade = GRADE_RE.exec(text);
  if (grade && (await repPhones(db)).has(phone)) {
    const [row] = await db<{ id: string; so_no: string }[]>`
      select id::text, so_no from notify_ledger
       where mode = 'shadow' and to_number = ${phone} and status in ('sent', 'queued', 'stubbed')
         and sent_at >= ${new Date(now.getTime() - 3 * 86_400_000)}
         and not (meta ? 'grade')
       order by sent_at desc, id desc limit 1
    `;
    if (row) {
      const g = { verdict: grade[1]!.toLowerCase(), note: grade[2]!.trim() || null, at: now.toISOString(), inbound_id: inboundId };
      await db`update notify_ledger set meta = meta || ${db.json({ grade: g })} where id = ${row.id}`;
      return done("shadow_grade", row.so_no);
    }
  }

  // A customer replying to a notification: route it to the SO's rep.
  const [last] = await db<{ so_no: string }[]>`
    select so_no from notify_ledger
     where mode = 'live' and recipient_role = 'customer' and to_number = ${phone} and so_no is not null
       and status in ('sent', 'queued', 'stubbed') and sent_at >= ${new Date(now.getTime() - 30 * 86_400_000)}
     order by sent_at desc, id desc limit 1
  `;
  if (!last) return done("unmatched");
  const header = await loadHeader(db, last.so_no);
  const rep = header ? await loadRep(db, header) : null;
  if (rep?.phone) {
    await recordSend(db, ch, {
      milestone: "reply_forward",
      soNo: last.so_no,
      role: "sales_cc",
      to: rep.phone,
      body: forwardText(header?.customer_name_text ?? "Pelanggan", phone, last.so_no, text),
    });
  }
  const [recent] = await db<{ n: number }[]>`
    select count(*)::int as n from notify_ledger
     where milestone = 'auto_reply' and to_number = ${phone} and created_at >= ${new Date(now.getTime() - 86_400_000)}
  `;
  if ((recent?.n ?? 0) === 0) {
    await recordSend(db, ch, {
      milestone: "auto_reply",
      soNo: last.so_no,
      role: "customer",
      to: phone,
      body: autoReplyText(rep?.name ?? null, rep?.phone ? localDisplay(rep.phone) : null),
    });
  }
  return done("forwarded", last.so_no);
}
