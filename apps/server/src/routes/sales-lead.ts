/**
 * Sales Lead routes.
 *
 * GET  /api/sales-lead?day=N  — all leads for a day (both reps), with sl_flag + sl_note.
 * POST /api/sales-lead/flag   — set sl_flag and optionally update sl_note.
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

interface LeadRow {
  id: string;
  day: number;
  rep: string;
  priority: string | null;
  company: string | null;
  town: string | null;
  province: string | null;
  ask_for: string | null;
  role: string | null;
  sl_flag: boolean;
  sl_note: string | null;
  invoice_id: string | null;
  transacted_as: string | null;
  review_status: string | null;
}

export async function salesLeadRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { day?: string } }>("/api/sales-lead", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const day = Number.parseInt(String(request.query.day ?? ""), 10);
    if (!Number.isInteger(day) || day < 1 || day > 10) {
      return reply.code(400).send({ error: "day must be an integer 1–10." });
    }

    const rows = await db<LeadRow[]>`
      select id, day, rep, priority, company, town, province, ask_for, role,
             coalesce(sl_flag, false) as sl_flag, sl_note,
             invoice_id, transacted_as, review_status
      from leads
      where day = ${day}
      order by priority asc, company asc
    `;

    return { day, count: rows.length, flagged: rows.filter((r) => r.sl_flag).length, leads: rows };
  });

  app.post<{ Body: { lead_id?: string; flagged?: boolean; note?: string } }>("/api/sales-lead/flag", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b = request.body ?? {};
    const lead_id = String(b.lead_id ?? "").trim();
    const flagged = Boolean(b.flagged);
    const note = b.note != null ? String(b.note) : null;

    if (!lead_id) return reply.code(400).send({ error: "lead_id is required." });

    const [updated] = await db<{ id: string; sl_flag: boolean; sl_note: string | null }[]>`
      update leads set
        sl_flag = ${flagged},
        sl_note = ${note !== null ? note : db`sl_note`}
      where id = ${lead_id}
      returning id, sl_flag, sl_note
    `;
    if (!updated) return reply.code(404).send({ error: "Lead not found." });

    return { ok: true, lead_id: updated.id, flagged: updated.sl_flag, note: updated.sl_note };
  });

  // GET /api/sales-lead/review — all sl_flag=true leads (across all days) for transaction review.
  app.get("/api/sales-lead/review", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const rows = await db<LeadRow[]>`
      select id, day, rep, priority, company, town, province, ask_for, role,
             coalesce(sl_flag, false) as sl_flag, sl_note,
             invoice_id, transacted_as, review_status
      from leads
      where coalesce(sl_flag, false) = true
      order by
        case when review_status is null then 0 else 1 end,
        day asc, priority asc, company asc
    `;

    const pending  = rows.filter((r) => !r.review_status);
    const resolved = rows.filter((r) => r.review_status != null);
    return { total: rows.length, pending: pending.length, resolved: resolved.length, leads: rows };
  });

  // POST /api/sales-lead/review — save invoice_id, transacted_as, review_status for a flagged lead.
  app.post<{
    Body: {
      lead_id?: string;
      invoice_id?: string | null;
      transacted_as?: string | null;
      review_status?: string | null;
    };
  }>("/api/sales-lead/review", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b = request.body ?? {};
    const lead_id = String(b.lead_id ?? "").trim();
    if (!lead_id) return reply.code(400).send({ error: "lead_id is required." });

    const invoice_id    = b.invoice_id    != null ? String(b.invoice_id).trim()    || null : null;
    const transacted_as = b.transacted_as != null ? String(b.transacted_as).trim() || null : null;
    const review_status = b.review_status != null ? String(b.review_status).trim() || null : null;

    const allowed = new Set(["irrelevant", "reviewed", null]);
    if (!allowed.has(review_status)) {
      return reply.code(400).send({ error: "review_status must be 'irrelevant', 'reviewed', or null." });
    }

    const [updated] = await db<{ id: string; invoice_id: string | null; transacted_as: string | null; review_status: string | null }[]>`
      update leads set
        invoice_id    = ${invoice_id},
        transacted_as = ${transacted_as},
        review_status = ${review_status}
      where id = ${lead_id}
      returning id, invoice_id, transacted_as, review_status
    `;
    if (!updated) return reply.code(404).send({ error: "Lead not found." });

    return { ok: true, lead_id: updated.id, invoice_id: updated.invoice_id, transacted_as: updated.transacted_as, review_status: updated.review_status };
  });
}
