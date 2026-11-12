/**
 * Kabar Pesanan — config + test pipeline API (MVP, stub channel by default).
 *
 * GET  /api/notify/config        — system number, channel mode/health, trigger rules
 * PUT  /api/notify/config        — set the system WhatsApp number        [token]
 * GET  /api/notify/order?so_no=  — read-only preview of a real SO from Selaras
 * POST /api/notify/test          — render + send ONE milestone to a test number,
 *                                  CC the sales number                   [token]
 * GET  /api/notify/ledger        — recent messages (test + live)
 *
 * [token] = needs `x-notify-token` when NOTIFY_ADMIN_TOKEN is set.
 *
 * Test sends go ONLY to the numbers typed into the form, never to the phone
 * stored on the SO. That number is shown masked so the tester can see who
 * would receive the message once live triggers are switched on.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeNumber } from "@kencana/core";
import { config } from "../config.js";
import { getSql } from "../db/client.js";
import { gatewayLinkStatus, getChannel } from "../notify/channel.js";
import { ErpLookupError, erpLookupAvailable, lookupOrder, type LookupResult } from "../notify/erpLookup.js";
import {
  MILESTONE_INFO,
  MILESTONES,
  isMilestone,
  renderCustomerMessage,
  renderSalesCc,
  sampleContext,
  type Milestone,
  type OrderContext,
} from "../notify/messages.js";

/** "+6281234567890" → "0812-3456-7890" for display inside a message. */
export function toLocalDisplay(e164: string): string {
  const local = e164.replace(/^\+62/, "0");
  return local.length >= 10 ? `${local.slice(0, 4)}-${local.slice(4, 8)}-${local.slice(8)}` : local;
}

function nowWib(): Date {
  return new Date(Date.now() + 7 * 3600 * 1000);
}

const sendTimes: number[] = [];
function rateLimited(): boolean {
  const cutoff = Date.now() - 10 * 60 * 1000;
  while (sendTimes.length && sendTimes[0]! < cutoff) sendTimes.shift();
  if (sendTimes.length >= config.notify.testSendsPer10Min) return true;
  sendTimes.push(Date.now());
  return false;
}
/** Test hook. */
export function resetNotifyRateLimit(): void {
  sendTimes.length = 0;
}

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  const required = config.notify.adminToken;
  if (!required) return true;
  if (req.headers["x-notify-token"] === required) return true;
  void reply.code(401).send({ error: "Token admin Kabar Pesanan salah atau belum diisi." });
  return false;
}

async function readSystemNumber(): Promise<{ systemNumber: string | null; updatedAt: string | null }> {
  const db = getSql();
  if (!db) return { systemNumber: null, updatedAt: null };
  try {
    const [row] = await db<{ system_number: string | null; updated_at: Date }[]>`
      select system_number, updated_at from notify_settings where id = 1
    `;
    return { systemNumber: row?.system_number ?? null, updatedAt: row?.updated_at?.toISOString() ?? null };
  } catch {
    return { systemNumber: null, updatedAt: null };
  }
}

/** Live-trigger state for /notify (mode, since when, outbox counts). */
async function liveStatus(): Promise<{
  mode: string;
  activeMode: string | null;
  since: string | null;
  counts: Record<string, number>;
  gateway?: { state: string; detail: string | null; at: string | null } | null;
} | null> {
  const db = getSql();
  if (!db) return { mode: config.notify.live, activeMode: null, since: null, counts: {} };
  try {
    const [s] = await db<{ live_mode: string | null; activation_watermark: Date | null; gateway_state: string | null; gateway_detail: string | null; gateway_state_at: Date | null }[]>`
      select live_mode, activation_watermark, gateway_state, gateway_detail, gateway_state_at from notify_settings where id = 1`;
    const rows = await db<{ status: string; n: number }[]>`
      select status, count(*)::int as n from notify_ledger where mode in ('live', 'shadow') group by status`;
    return {
      mode: config.notify.live,
      activeMode: s?.live_mode ?? null,
      since: s?.activation_watermark?.toISOString() ?? null,
      counts: Object.fromEntries(rows.map((r) => [r.status, r.n])),
      gateway: s?.gateway_state
        ? { state: s.gateway_state, detail: s.gateway_detail, at: s.gateway_state_at?.toISOString() ?? null }
        : null,
    };
  } catch {
    return { mode: config.notify.live, activeMode: null, since: null, counts: {} };
  }
}

interface TestBody {
  milestone?: unknown;
  customerNumber?: unknown;
  salesNumber?: unknown;
  salesName?: unknown;
  soNo?: unknown;
  introduce?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export async function notifyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notify/config", async () => {
    const channel = getChannel();
    const [{ systemNumber, updatedAt }, health, gateway] = await Promise.all([
      readSystemNumber(),
      channel.health(),
      gatewayLinkStatus(),
    ]);
    return {
      systemNumber,
      systemNumberDisplay: systemNumber ? toLocalDisplay(systemNumber) : null,
      updatedAt,
      channel: { mode: channel.mode, ...health },
      gateway,
      adminTokenRequired: Boolean(config.notify.adminToken),
      erpLookupAvailable: erpLookupAvailable(),
      databaseAvailable: Boolean(getSql()),
      milestones: MILESTONES.map((m) => ({ key: m, ...MILESTONE_INFO[m] })),
      live: await liveStatus(),
    };
  });

  app.put("/api/notify/config", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const raw = str((req.body as { systemNumber?: unknown } | null)?.systemNumber);
    const e164 = raw ? normalizeNumber(raw) : null;
    if (raw && !e164) return reply.code(400).send({ error: "Nomor sistem bukan nomor HP Indonesia yang valid." });
    await db`update notify_settings set system_number = ${e164}, updated_at = now() where id = 1`;
    return { systemNumber: e164, systemNumberDisplay: e164 ? toLocalDisplay(e164) : null };
  });

  app.get("/api/notify/order", async (req, reply) => {
    const soNo = str((req.query as { so_no?: unknown }).so_no);
    if (!soNo) return reply.code(400).send({ error: "Isi nomor SO." });
    try {
      const r = await lookupOrder(soNo, { salesWa: null, salesNameOverride: null });
      return {
        soNo: r.context.soNo,
        customerName: r.context.customerName,
        recipientName: r.context.recipientName,
        salesName: r.context.salesName,
        items: r.context.items,
        production: r.context.production,
        delivery: r.context.delivery,
        erpRecipientPhoneMasked: r.erpRecipientPhoneMasked,
        paymentTerm: r.paymentTerm,
        statusOrder: r.statusOrder,
      };
    } catch (err) {
      if (err instanceof ErpLookupError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post("/api/notify/test", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const channel = getChannel();
    if (channel.mode === "gateway" && !config.notify.adminToken) {
      return reply.code(503).send({ error: "Isi NOTIFY_ADMIN_TOKEN sebelum memakai mode gateway." });
    }

    const body = (req.body ?? {}) as TestBody;
    if (!isMilestone(body.milestone)) {
      return reply.code(400).send({ error: `milestone harus salah satu dari: ${MILESTONES.join(", ")}.` });
    }
    const milestone: Milestone = body.milestone;

    const customer = normalizeNumber(str(body.customerNumber));
    if (!customer) return reply.code(400).send({ error: "Nomor pelanggan (uji) bukan nomor HP Indonesia yang valid." });
    const salesRaw = str(body.salesNumber);
    const sales = salesRaw ? normalizeNumber(salesRaw) : null;
    if (salesRaw && !sales) return reply.code(400).send({ error: "Nomor sales (CC) bukan nomor HP Indonesia yang valid." });
    const salesName = str(body.salesName) || null;
    const soNo = str(body.soNo);

    if (rateLimited()) {
      return reply.code(429).send({ error: "Terlalu banyak kirim uji. Tunggu beberapa menit." });
    }

    const salesWa = sales ? toLocalDisplay(sales) : null;
    let ctx: OrderContext;
    let lookup: LookupResult | null = null;
    const warnings: string[] = [];
    if (soNo) {
      try {
        lookup = await lookupOrder(soNo, { salesWa, salesNameOverride: salesName });
      } catch (err) {
        if (err instanceof ErpLookupError) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
      ctx = lookup.context;
    } else {
      ctx = sampleContext(nowWib(), salesName, salesWa);
    }

    const sample = sampleContext(nowWib(), salesName, salesWa);
    if (milestone === "production_started" && ctx.source === "erp" && !ctx.production) {
      warnings.push(
        "SO ini tidak punya Request Produksi (dilayani dari stok). Di mode live, pesan langkah 2 TIDAK akan terkirim untuk SO ini.",
      );
    }
    if (milestone === "delivery_scheduled" && !ctx.delivery) {
      warnings.push("SO ini belum punya Delivery Order. Pesan memakai nomor surat jalan & tanggal contoh.");
      ctx = { ...ctx, delivery: sample.delivery };
    }

    const { systemNumber } = await readSystemNumber();
    const customerText = renderCustomerMessage(milestone, ctx, { introduce: body.introduce === true });
    const outbound: { role: "customer" | "sales_cc"; to: string; text: string }[] = [
      { role: "customer", to: customer, text: customerText },
    ];
    if (sales) {
      outbound.push({
        role: "sales_cc",
        to: sales,
        text: renderSalesCc(milestone, ctx, toLocalDisplay(customer), customerText),
      });
    }

    const db = getSql();
    const results = [];
    for (const o of outbound) {
      const idempotencyKey = `test:${milestone}:${o.role}:${o.to}:${randomUUID()}`;
      const r = await channel.send({ to: o.to, text: o.text, idempotencyKey });
      if (db) {
        try {
          await db`
            insert into notify_ledger
              (mode, milestone, so_no, recipient_role, to_number, from_number, body, channel,
               status, provider_message_id, error, context_source, idempotency_key)
            values
              ('test', ${milestone}, ${ctx.soNo}, ${o.role}, ${o.to}, ${systemNumber}, ${o.text}, ${channel.mode},
               ${r.status}, ${r.providerMessageId}, ${r.error}, ${ctx.source}, ${idempotencyKey})
          `;
        } catch (err) {
          req.log.warn({ err }, "notify ledger write failed");
          warnings.push("Pesan diproses tetapi gagal dicatat di Riwayat.");
        }
      }
      results.push({ role: o.role, to: o.to, toDisplay: toLocalDisplay(o.to), text: o.text, ...r });
    }
    if (!db) warnings.push("Database tidak tersedia: pesan tidak dicatat di Riwayat.");

    return {
      milestone,
      label: MILESTONE_INFO[milestone].label,
      channel: channel.mode,
      from: systemNumber ? toLocalDisplay(systemNumber) : null,
      context: {
        soNo: ctx.soNo,
        customerName: ctx.customerName,
        source: ctx.source,
        erpRecipientPhoneMasked: lookup?.erpRecipientPhoneMasked ?? null,
      },
      warnings,
      messages: results,
    };
  });

  app.get("/api/notify/ledger", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const q = req.query as { limit?: string; mode?: string; status?: string; so_no?: string };
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 50));
    const mode = q.mode && ["test", "live", "shadow"].includes(q.mode) ? q.mode : null;
    const status = typeof q.status === "string" && /^[a-z_]{1,20}$/.test(q.status) ? q.status : null;
    const soNo = typeof q.so_no === "string" && q.so_no.trim() ? q.so_no.trim() : null;
    const rows = await db`
      select id, mode, milestone, so_no, recipient_role, to_number, from_number, body, channel,
             status, provider_message_id, error, context_source, created_at,
             due_at, sent_at, cancel_reason, attempts, template_version, meta
      from notify_ledger
      where (${mode}::text is null or mode = ${mode})
        and (${status}::text is null or status = ${status})
        and (${soNo}::text is null or so_no = ${soNo})
      order by created_at desc, id desc
      limit ${limit}
    `;
    return { rows };
  });

  // ── Rep phones for the sales CC (PRD §9.4; the /notify table is WP-6) ──
  app.get("/api/notify/sales-contacts", async (_req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const rows = await db`
      select coalesce(es.id, nc.erp_sales_id) as erp_sales_id,
             coalesce(es.sales_name, nc.sales_name) as sales_name,
             es.department, es.active,
             es.phone as selaras_phone, nc.phone_e164, coalesce(nc.cc_enabled, true) as cc_enabled,
             nc.updated_at
        from erp_sales es
        full outer join notify_sales_contacts nc on nc.erp_sales_id = es.id
       where es.deleted_at is null or es.id is null
       order by (lower(coalesce(es.active, '')) in ('yes', 'active', '1', 'true')) desc, 2
    `;
    return { rows };
  });

  app.put("/api/notify/sales-contacts/:id", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const id = str((req.params as { id?: unknown }).id);
    if (!id) return reply.code(400).send({ error: "ID sales Selaras kosong." });
    const body = (req.body ?? {}) as { phone?: unknown; ccEnabled?: unknown; salesName?: unknown };
    const raw = str(body.phone);
    const phone = raw ? normalizeNumber(raw) : null;
    if (raw && !phone) return reply.code(400).send({ error: "Nomor sales bukan nomor HP Indonesia yang valid." });
    const cc = body.ccEnabled === undefined ? true : body.ccEnabled === true;
    const name = str(body.salesName) || null;
    await db`
      insert into notify_sales_contacts (erp_sales_id, sales_name, phone_e164, cc_enabled, source, updated_at)
      values (${id}, ${name}, ${phone}, ${cc}, 'manual', now())
      on conflict (erp_sales_id) do update set
        phone_e164 = excluded.phone_e164,
        cc_enabled = excluded.cc_enabled,
        sales_name = coalesce(excluded.sales_name, notify_sales_contacts.sales_name),
        updated_at = now()
    `;
    return { erpSalesId: id, phone, phoneDisplay: phone ? toLocalDisplay(phone) : null, ccEnabled: cc };
  });
}
