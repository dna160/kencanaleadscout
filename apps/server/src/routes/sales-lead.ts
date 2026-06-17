/**
 * Sales Lead routes.
 *
 * GET  /api/sales-lead?day=N  — all leads for a day (both reps), with sl_flag.
 * POST /api/sales-lead/flag   — toggle sl_flag on a lead.
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
             coalesce(sl_flag, false) as sl_flag
      from leads
      where day = ${day}
      order by priority asc, company asc
    `;

    return { day, count: rows.length, flagged: rows.filter((r) => r.sl_flag).length, leads: rows };
  });

  app.post<{ Body: { lead_id?: string; flagged?: boolean } }>("/api/sales-lead/flag", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b = request.body ?? {};
    const lead_id = String(b.lead_id ?? "").trim();
    const flagged = Boolean(b.flagged);

    if (!lead_id) return reply.code(400).send({ error: "lead_id is required." });

    const [updated] = await db<{ id: string; sl_flag: boolean }[]>`
      update leads set sl_flag = ${flagged} where id = ${lead_id}
      returning id, sl_flag
    `;
    if (!updated) return reply.code(404).send({ error: "Lead not found." });

    return { ok: true, lead_id: updated.id, flagged: updated.sl_flag };
  });
}
