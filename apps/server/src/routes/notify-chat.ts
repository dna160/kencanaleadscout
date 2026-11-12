/**
 * Kabar Pesanan — "Pesan" tab: a WhatsApp-Web-style view of the notification
 * number, one conversation per phone.
 *
 * GET  /api/notify/chats?q=&limit=        conversation list (last message, unread, who it is)
 * GET  /api/notify/chats/:phone           the thread: what we sent + what came in, oldest first
 * POST /api/notify/chats/:phone/read      mark the conversation read
 * POST /api/notify/chats/:phone/reply     {text} — admin reply                         [token]
 *
 * A thread is assembled from what already exists: outbound = notify_ledger rows
 * that reached (or were meant to reach) that number; inbound = notify_inbound.
 *
 * Replies are deliberately narrow: only to a number that has WRITTEN IN (this
 * is an answer, not a way to message arbitrary numbers), never to an opted-out
 * number, never while the kill switch is on, and every reply is logged in
 * notify_ledger with who sent it (milestone `manual_reply`).
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeNumber } from "@kencana/core";
import { config } from "../config.js";
import { getSql } from "../db/client.js";
import { getChannel } from "../notify/channel.js";
import { TEMPLATE_VERSION } from "../notify/messages.js";

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  const required = config.notify.adminToken;
  if (!required) return true;
  if (req.headers["x-notify-token"] === required) return true;
  void reply.code(401).send({ error: "Token admin Kabar Pesanan salah atau belum diisi." });
  return false;
}

function actor(req: FastifyRequest): string {
  const a = req.headers["x-notify-actor"];
  return typeof a === "string" && a.trim() ? a.trim().slice(0, 60) : "admin";
}

/** The :phone path segment, URL-encoded E.164 ("%2B6281…") or a local number. */
function phoneParam(req: FastifyRequest): string | null {
  const raw = String((req.params as { phone?: unknown }).phone ?? "");
  return normalizeNumber(decodeURIComponent(raw));
}

/** Outbound rows that belong in a chat: actually sent, or attempted and visible as such. */
const OUT_STATUSES = ["sent", "queued", "stubbed", "failed", "held"];
export const MAX_REPLY_CHARS = 2000;

export async function notifyChatRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notify/chats", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const q = req.query as { q?: string; limit?: string };
    const limit = Math.min(300, Math.max(1, Number(q.limit) || 100));
    const search = typeof q.q === "string" && q.q.trim() ? q.q.trim() : null;
    const like = search ? `%${search.replace(/[%_\\]/g, "\\$&")}%` : null;
    const digits = search ? search.replace(/\D/g, "").replace(/^0/, "") : "";
    const rows = await db`
      with msgs as (
        select to_number as phone, coalesce(sent_at, created_at) as at, body as text, 'out'::text as dir,
               so_no, mode
          from notify_ledger
         where to_number is not null and body is not null and status = any(${OUT_STATUSES})
        union all
        select from_pn, received_at, text, 'in', so_no, null
          from notify_inbound where from_pn is not null
      ),
      last as (
        select distinct on (phone) phone, at, text, dir, mode from msgs order by phone, at desc
      ),
      enriched as (
        select l.phone, l.at, l.text, l.dir, l.mode,
               (select m.so_no from msgs m where m.phone = l.phone and m.so_no is not null order by m.at desc limit 1) as so_no,
               (select count(*)::int from notify_inbound i
                 where i.from_pn = l.phone and i.received_at > coalesce(r.last_read_at, 'epoch'::timestamptz)) as unread,
               exists (select 1 from notify_inbound i where i.from_pn = l.phone) as wrote_in,
               coalesce(c.consent_state, 'implied') as consent,
               (select coalesce(es.sales_name, nc.sales_name) from notify_sales_contacts nc
                  left join erp_sales es on es.id = nc.erp_sales_id
                 where nc.phone_e164 = l.phone limit 1) as rep_name
          from last l
          left join notify_chat_reads r on r.phone_e164 = l.phone
          left join notify_contacts c on c.phone_e164 = l.phone
      )
      select e.*, h.customer_name_text as customer
        from enriched e
        left join lateral (select customer_name_text from erp_so_header where po_no = e.so_no
                            order by erp_updated_at desc nulls last limit 1) h on true
       where ${like}::text is null
          or (${digits}::text <> '' and e.phone like ${`%${digits}%`})
          or h.customer_name_text ilike ${like ?? ""}
          or e.rep_name ilike ${like ?? ""}
          or e.so_no ilike ${like ?? ""}
       order by e.at desc
       limit ${limit}
    `;
    const [{ n } = { n: 0 }] = await db<{ n: number }[]>`
      select count(*)::int as n from notify_inbound i
        left join notify_chat_reads r on r.phone_e164 = i.from_pn
       where i.from_pn is not null and i.received_at > coalesce(r.last_read_at, 'epoch'::timestamptz)`;
    return { rows, unreadTotal: n };
  });

  app.get("/api/notify/chats/:phone", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const phone = phoneParam(req);
    if (!phone) return reply.code(400).send({ error: "Nomor tidak valid." });
    const [out, inn, [contact], [ks]] = await Promise.all([
      db`
        select id::text, mode, milestone, so_no, recipient_role, body as text, status, cancel_reason, error,
               coalesce(sent_at, created_at) as at, delivered_at, read_at, meta->>'by' as by
          from notify_ledger
         where to_number = ${phone} and body is not null and status = any(${OUT_STATUSES})
         order by coalesce(sent_at, created_at) desc, id desc limit 300`,
      db`
        select id::text, text, action, so_no, received_at as at
          from notify_inbound where from_pn = ${phone} order by received_at desc, id desc limit 300`,
      db<{ consent_state: string; opted_out_at: Date | null }[]>`
        select consent_state, opted_out_at from notify_contacts where phone_e164 = ${phone}`,
      db<{ kill_switch: boolean }[]>`select kill_switch from notify_settings where id = 1`,
    ]);
    type Msg = Record<string, unknown> & { at: Date; dir: "in" | "out"; id: string };
    const messages: Msg[] = [
      ...out.map((m) => ({ ...(m as Record<string, unknown>), dir: "out" }) as Msg),
      ...inn.map((m) => ({ ...(m as Record<string, unknown>), dir: "in" }) as Msg),
    ].sort((a, b) => a.at.getTime() - b.at.getTime() || (a.dir === b.dir ? Number(a.id) - Number(b.id) : a.dir === "in" ? -1 : 1));
    const optedOut = contact?.consent_state === "opted_out";
    const canReply = !optedOut && inn.length > 0 && !ks?.kill_switch;
    return {
      phone,
      optedOut,
      canReply,
      replyBlockedReason: optedOut
        ? "Nomor ini sudah berhenti berlangganan (STOP)."
        : ks?.kill_switch
          ? "Saklar darurat aktif: semua pengiriman dihentikan."
          : inn.length === 0
            ? "Balasan hanya untuk nomor yang sudah mengirim pesan ke nomor notifikasi."
            : null,
      messages,
    };
  });

  app.post("/api/notify/chats/:phone/read", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const phone = phoneParam(req);
    if (!phone) return reply.code(400).send({ error: "Nomor tidak valid." });
    await db`
      insert into notify_chat_reads (phone_e164, last_read_at, read_by) values (${phone}, now(), ${actor(req)})
      on conflict (phone_e164) do update set last_read_at = now(), read_by = excluded.read_by`;
    return { ok: true };
  });

  app.post("/api/notify/chats/:phone/reply", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const phone = phoneParam(req);
    if (!phone) return reply.code(400).send({ error: "Nomor tidak valid." });
    const text = typeof (req.body as { text?: unknown } | null)?.text === "string"
      ? ((req.body as { text: string }).text).trim()
      : "";
    if (!text) return reply.code(400).send({ error: "Pesan kosong." });
    if (text.length > MAX_REPLY_CHARS) return reply.code(400).send({ error: `Maksimal ${MAX_REPLY_CHARS} karakter.` });

    const [[contact], [wrote], [ks]] = await Promise.all([
      db<{ consent_state: string }[]>`select consent_state from notify_contacts where phone_e164 = ${phone}`,
      db<{ n: number }[]>`select count(*)::int as n from notify_inbound where from_pn = ${phone}`,
      db<{ kill_switch: boolean }[]>`select kill_switch from notify_settings where id = 1`,
    ]);
    if (contact?.consent_state === "opted_out") return reply.code(409).send({ error: "Nomor ini sudah berhenti berlangganan (STOP)." });
    if (ks?.kill_switch) return reply.code(409).send({ error: "Saklar darurat aktif: semua pengiriman dihentikan." });
    if (!wrote || wrote.n === 0) {
      return reply.code(409).send({ error: "Balasan hanya untuk nomor yang sudah mengirim pesan ke nomor notifikasi." });
    }

    const [last] = await db<{ so_no: string | null }[]>`
      select so_no from notify_inbound where from_pn = ${phone} and so_no is not null order by received_at desc limit 1`;
    const ch = getChannel();
    const key = `manual:${phone}:${randomUUID()}`;
    const by = actor(req);
    const r = await ch.send({ to: phone, text, idempotencyKey: key });
    const sent = ["sent", "queued", "stubbed"].includes(r.status);
    const [row] = await db<{ id: string }[]>`
      insert into notify_ledger (mode, milestone, so_no, recipient_role, to_number, body, channel, status,
                                 provider_message_id, error, context_source, idempotency_key, template_version,
                                 sent_at, meta)
      values ('live', 'manual_reply', ${last?.so_no ?? null}, 'customer', ${phone}, ${text}, ${ch.mode}, ${r.status},
              ${r.providerMessageId}, ${r.error}, 'manual', ${key}, ${TEMPLATE_VERSION},
              ${sent ? new Date() : null}, ${db.json({ by })})
      returning id::text`;
    // Replying counts as reading.
    await db`
      insert into notify_chat_reads (phone_e164, last_read_at, read_by) values (${phone}, now(), ${by})
      on conflict (phone_e164) do update set last_read_at = now(), read_by = excluded.read_by`;
    req.log.info({ actor: by, phone, status: r.status }, "notify manual reply");
    if (!sent) return reply.code(502).send({ error: r.error ?? "Gagal mengirim.", id: row!.id, status: r.status });
    return { ok: true, id: row!.id, status: r.status };
  });
}
