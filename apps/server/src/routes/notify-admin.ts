/**
 * Kabar Pesanan WP-6 — the admin API behind the /notify tabs.
 *
 * GET  /api/notify/live                     mode, switches, outbox counts, gateway + mirror health
 * PUT  /api/notify/live                     {killSwitch?, milestones?}                    [token]
 * GET  /api/notify/outbox?view=             pending | held | problems | recent
 * POST /api/notify/outbox/:id/action        {action: send_now|release|cancel|grade, …}  [token]
 * GET  /api/notify/overrides                customer overrides and mutes
 * PUT  /api/notify/overrides/:customerId    {phone?, muted, reason?}                     [token]
 * GET  /api/notify/customers?q=             customer search (recent SOs) for the override form
 * GET  /api/notify/shadow?days=             shadow grading summary + rows
 * GET  /api/notify/inbound?limit=           recent replies from customers and reps
 * GET  /api/notify/gateway/pair-svg         pairing QR as SVG                            [token]
 *
 * The live MODE (off/shadow/on) is deliberately NOT switchable here: it stays
 * the NOTIFY_LIVE env var, so turning customers on is a deploy decision with a
 * name on it, not a click. The kill switch only ever makes things safer.
 *
 * Writes record who acted from `x-notify-actor` (the name typed on /notify).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import QRCode from "qrcode";
import { normalizeNumber } from "@kencana/core";
import { config } from "../config.js";
import { getSql } from "../db/client.js";
import { isOrderLaneEnabled, orderLaneStatus } from "../erp/orderSync.js";
import { getChannel, getGatewayAdmin } from "../notify/channel.js";
import { MILESTONES } from "../notify/messages.js";
import { redactSecrets } from "../erp/selarasClient.js";

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

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const VIEWS: Record<string, string> = {
  pending: "status in ('pending', 'sending')",
  held: "status = 'held'",
  problems: "status in ('failed', 'unreachable')",
  recent: "true",
};

export async function notifyAdminRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notify/live", async (_req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const ch = getChannel();
    const [[s], counts, health, lane] = await Promise.all([
      db<{
        live_mode: string | null; activation_watermark: Date | null; kill_switch: boolean;
        milestones_enabled: Record<string, boolean>; switches_set_by: string | null;
        gateway_state: string | null; gateway_detail: string | null; gateway_state_at: Date | null;
      }[]>`
        select live_mode, activation_watermark, kill_switch, milestones_enabled, switches_set_by,
               gateway_state, gateway_detail, gateway_state_at
          from notify_settings where id = 1`,
      db<{ status: string; n: number }[]>`
        select status, count(*)::int as n from notify_ledger
         where mode in ('live', 'shadow') and created_at >= now() - interval '7 days' group by status`,
      ch.health(),
      orderLaneStatus(db).catch(() => []),
    ]);
    return {
      mode: config.notify.live,
      activeMode: s?.live_mode ?? null,
      since: s?.activation_watermark ?? null,
      killSwitch: s?.kill_switch ?? false,
      switchesSetBy: s?.switches_set_by ?? null,
      milestones: MILESTONES.map((m) => ({ key: m, enabled: s?.milestones_enabled?.[m] !== false })),
      counts7d: Object.fromEntries(counts.map((c) => [c.status, c.n])),
      channel: { mode: ch.mode, ...health },
      gateway: s?.gateway_state ? { state: s.gateway_state, detail: s.gateway_detail, at: s.gateway_state_at } : null,
      lane: { enabled: isOrderLaneEnabled(), tables: lane },
      holds: config.notify.holdMinutes,
      window: { from: config.notify.quietStartHour, until: config.notify.quietEndHour },
      dailyCapPerPhone: config.notify.dailyCapPerPhone,
    };
  });

  app.put("/api/notify/live", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const body = (req.body ?? {}) as { killSwitch?: unknown; milestones?: unknown };
    const kill = typeof body.killSwitch === "boolean" ? body.killSwitch : null;
    const ms: Record<string, boolean> = {};
    if (body.milestones && typeof body.milestones === "object") {
      for (const [k, v] of Object.entries(body.milestones as Record<string, unknown>)) {
        if ((MILESTONES as readonly string[]).includes(k) && typeof v === "boolean") ms[k] = v;
      }
    }
    await db`
      update notify_settings set
        kill_switch        = coalesce(${kill}, kill_switch),
        milestones_enabled = milestones_enabled || ${db.json(ms)},
        switches_set_by    = ${`${actor(req)} @ ${new Date().toISOString()}`},
        updated_at         = now()
       where id = 1
    `;
    req.log.warn({ actor: actor(req), killSwitch: kill, milestones: ms }, "notify switches changed");
    return { ok: true };
  });

  app.get("/api/notify/outbox", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const q = req.query as { view?: string; limit?: string };
    const where = VIEWS[q.view ?? "pending"];
    if (!where) return reply.code(400).send({ error: `view harus salah satu dari: ${Object.keys(VIEWS).join(", ")}.` });
    const limit = Math.min(300, Math.max(1, Number(q.limit) || 100));
    const rows = await db.unsafe(
      `select l.id::text, l.mode, l.milestone, l.so_no, l.recipient_role, l.to_number, l.status, l.cancel_reason,
              l.due_at, l.sent_at, l.created_at, l.attempts, l.error, l.body, l.meta,
              h.customer_name_text as customer
         from notify_ledger l
         left join lateral (select customer_name_text from erp_so_header where po_no = l.so_no limit 1) h on true
        where l.mode in ('live', 'shadow') and ${where}
        order by ${q.view === "pending" ? "l.due_at asc, l.id asc" : "l.id desc"}
        limit $1`,
      [limit],
    );
    return { rows };
  });

  app.post("/api/notify/outbox/:id/action", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const id = Number((req.params as { id?: string }).id);
    if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: "ID tidak valid." });
    const body = (req.body ?? {}) as { action?: unknown; verdict?: unknown; note?: unknown };
    const who = actor(req);
    const at = new Date().toISOString();
    let changed: readonly unknown[] = [];
    switch (body.action) {
      case "send_now": // skip the remaining hold; every other guard still applies
        changed = await db`
          update notify_ledger set due_at = now(), meta = meta || ${db.json({ sendNowBy: who, sendNowAt: at })}
           where id = ${id} and status = 'pending' and mode in ('live', 'shadow') returning id`;
        break;
      case "release": // a reviewed shared number: send despite the guard
        changed = await db`
          update notify_ledger set status = 'pending', due_at = now(), cancel_reason = null,
                 meta = meta || ${db.json({ released: true, releasedBy: who, releasedAt: at })}
           where id = ${id} and status = 'held' returning id`;
        // Its CC follows the customer row again.
        await db`
          update notify_ledger c set status = 'pending', due_at = now(), cancel_reason = null
            from notify_ledger p
           where p.id = ${id} and c.idempotency_key = replace(p.idempotency_key, ':customer', ':sales_cc')
             and c.status = 'held'`;
        break;
      case "cancel":
        changed = await db`
          update notify_ledger set status = 'cancelled', cancel_reason = 'admin_cancel', leased_until = null,
                 meta = meta || ${db.json({ cancelledBy: who, cancelledAt: at })}
           where id = ${id} and status in ('pending', 'held') returning id`;
        await db`
          update notify_ledger c set status = 'cancelled', cancel_reason = 'admin_cancel'
            from notify_ledger p
           where p.id = ${id} and c.idempotency_key = replace(p.idempotency_key, ':customer', ':sales_cc')
             and c.status in ('pending', 'held')`;
        break;
      case "grade": {
        const verdict = str(body.verdict).toLowerCase();
        if (verdict !== "benar" && verdict !== "salah") return reply.code(400).send({ error: "verdict: benar atau salah." });
        const grade = { verdict, note: str(body.note) || null, at, by: who };
        changed = await db`
          update notify_ledger set meta = meta || ${db.json({ grade })}
           where id = ${id} and mode = 'shadow' returning id`;
        break;
      }
      default:
        return reply.code(400).send({ error: "action: send_now, release, cancel atau grade." });
    }
    if (!changed.length) return reply.code(409).send({ error: "Baris tidak ditemukan atau statusnya tidak cocok untuk aksi ini." });
    req.log.info({ actor: who, id, action: body.action }, "notify outbox action");
    return { ok: true };
  });

  app.get("/api/notify/overrides", async (_req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const rows = await db`
      select o.customer_name_id, o.phone_e164, o.muted, o.set_by, o.reason, o.updated_at,
             (select customer_name_text from erp_so_header h where h.customer_name_id = o.customer_name_id
               order by erp_created_at desc nulls last limit 1) as customer
        from notify_customer_overrides o order by o.updated_at desc`;
    return { rows };
  });

  app.put("/api/notify/overrides/:customerId", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const cid = str((req.params as { customerId?: unknown }).customerId);
    if (!cid) return reply.code(400).send({ error: "ID pelanggan kosong." });
    const body = (req.body ?? {}) as { phone?: unknown; muted?: unknown; reason?: unknown; remove?: unknown };
    if (body.remove === true) {
      await db`delete from notify_customer_overrides where customer_name_id = ${cid}`;
      return { ok: true, removed: true };
    }
    const raw = str(body.phone);
    const phone = raw ? normalizeNumber(raw) : null;
    if (raw && !phone) return reply.code(400).send({ error: "Nomor bukan nomor HP Indonesia yang valid." });
    await db`
      insert into notify_customer_overrides (customer_name_id, phone_e164, muted, set_by, reason, updated_at)
      values (${cid}, ${phone}, ${body.muted === true}, ${actor(req)}, ${str(body.reason) || null}, now())
      on conflict (customer_name_id) do update set phone_e164 = excluded.phone_e164, muted = excluded.muted,
        set_by = excluded.set_by, reason = excluded.reason, updated_at = now()
    `;
    return { ok: true, phone };
  });

  app.get("/api/notify/customers", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const q = str((req.query as { q?: unknown }).q);
    if (q.length < 2) return { rows: [] };
    const rows = await db`
      select customer_name_id, max(customer_name_text) as customer, count(*)::int as sos,
             max(po_date) as last_po_date
        from erp_so_header
       where customer_name_id is not null and customer_name_text ilike ${`%${q.replace(/[%_\\]/g, "\\$&")}%`}
       group by customer_name_id order by max(po_date) desc nulls last limit 20`;
    return { rows };
  });

  app.get("/api/notify/shadow", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const days = Math.min(90, Math.max(1, Number((req.query as { days?: string }).days) || 14));
    const since = new Date(Date.now() - days * 86_400_000);
    const [sum] = await db<{ sent: number; graded: number; benar: number; salah: number }[]>`
      select count(*)::int as sent,
             count(*) filter (where meta ? 'grade')::int as graded,
             count(*) filter (where meta->'grade'->>'verdict' = 'benar')::int as benar,
             count(*) filter (where meta->'grade'->>'verdict' = 'salah')::int as salah
        from notify_ledger
       where mode = 'shadow' and status in ('sent', 'queued', 'stubbed') and sent_at >= ${since}`;
    const rows = await db`
      select l.id::text, l.milestone, l.so_no, l.to_number, l.sent_at, l.body, l.meta,
             h.customer_name_text as customer
        from notify_ledger l
        left join lateral (select customer_name_text from erp_so_header where po_no = l.so_no limit 1) h on true
       where l.mode = 'shadow' and l.status in ('sent', 'queued', 'stubbed') and l.sent_at >= ${since}
       order by (l.meta->'grade'->>'verdict' = 'salah') desc nulls last, l.sent_at desc
       limit 200`;
    const s = sum ?? { sent: 0, graded: 0, benar: 0, salah: 0 };
    return {
      days,
      summary: { ...s, pctBenar: s.graded ? Math.round((s.benar / s.graded) * 1000) / 10 : null, gate: 99 },
      rows,
    };
  });

  app.get("/api/notify/inbound", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const limit = Math.min(200, Math.max(1, Number((req.query as { limit?: string }).limit) || 50));
    const rows = await db`
      select id::text, from_pn, from_lid, text, action, so_no, received_at
        from notify_inbound order by id desc limit ${limit}`;
    return { rows };
  });

  app.get("/api/notify/gateway/pair-svg", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const gw = getGatewayAdmin();
    if (!gw) return reply.code(409).send({ error: "NOTIFY_CHANNEL bukan gateway." });
    try {
      const st = await gw.pair();
      if (st.paired || !st.qr) return { paired: st.paired, jid: st.jid ?? null, error: st.error ?? null };
      const svg = await QRCode.toString(st.qr, { type: "svg", margin: 1, errorCorrectionLevel: "L" });
      return { paired: false, svg, expiresIn: st.expires_in ?? null };
    } catch (err) {
      return reply.code(502).send({ error: redactSecrets(err) });
    }
  });
}
