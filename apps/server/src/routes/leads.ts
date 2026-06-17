/**
 * [B] GET /api/leads?rep=Rep%20A&day=1
 *
 * Returns the rep's leads for a day, each joined to its current outcome and to
 * any scraper enrichment (pre-found WA number). Ordered by priority then company.
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

const REPS = new Set(["Rep A", "Rep B"]);

interface LeadRow {
  id: string;
  day: number;
  rep: string;
  priority: string | null;
  company: string | null;
  town: string | null;
  province: string | null;
  landline: string | null;
  ask_for: string | null;
  role: string | null;
  email: string | null;
  website: string | null;
  o_status: string | null;
  o_wa_number: string | null;
  o_pic_name: string | null;
  o_sample_sent: boolean | null;
  o_updated_at: Date | null;
  o_updated_by: string | null;
  scraped_wa: string | null;
  scraped_confidence: string | null;
  scraped_source: string | null;
}

export async function leadsRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { rep?: string; day?: string } }>("/api/leads", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const rep = String(request.query.rep ?? "");
    const day = Number.parseInt(String(request.query.day ?? ""), 10);
    if (!REPS.has(rep)) return reply.code(400).send({ error: "rep must be 'Rep A' or 'Rep B'." });
    if (!Number.isInteger(day) || day < 1 || day > 10) {
      return reply.code(400).send({ error: "day must be an integer 1–10." });
    }

    const rows = await db<LeadRow[]>`
      select
        l.id, l.day, l.rep, l.priority, l.company, l.town, l.province,
        l.landline, l.ask_for, l.role, l.email, l.website,
        o.status      as o_status,
        o.wa_number   as o_wa_number,
        o.pic_name    as o_pic_name,
        o.sample_sent as o_sample_sent,
        o.updated_at  as o_updated_at,
        o.updated_by  as o_updated_by,
        e.wa_numbers  as scraped_wa,
        e.confidence  as scraped_confidence,
        e.source      as scraped_source
      from leads l
      left join outcomes o on o.lead_id = l.id
      left join enrichments e
        on e.company_norm = btrim(regexp_replace(lower(l.company), '[^a-z0-9]+', ' ', 'g'))
      where l.rep = ${rep} and l.day = ${day}
        and coalesce(l.sl_flag, false) = false
      order by l.priority asc, l.company asc
    `;

    const leads = rows.map((r) => ({
      id: r.id,
      day: r.day,
      rep: r.rep,
      priority: r.priority,
      company: r.company,
      town: r.town,
      province: r.province,
      landline: r.landline,
      ask_for: r.ask_for,
      role: r.role,
      email: r.email,
      website: r.website,
      outcome: r.o_status
        ? {
            status: r.o_status,
            wa_number: r.o_wa_number,
            pic_name: r.o_pic_name,
            sample_sent: r.o_sample_sent ?? false,
            updated_at: r.o_updated_at,
            updated_by: r.o_updated_by,
          }
        : null,
      scraped: r.scraped_wa
        ? {
            wa_numbers: r.scraped_wa.split(",").map((s) => s.trim()).filter(Boolean),
            confidence: r.scraped_confidence,
            source: r.scraped_source,
          }
        : null,
    }));

    return { rep, day, count: leads.length, leads };
  });
}
