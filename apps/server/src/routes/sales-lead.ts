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
             coalesce(sl_flag, false) as sl_flag, sl_note
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
}
