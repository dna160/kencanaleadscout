/**
 * [D] Insights dashboard routes (microPRD §9).
 *
 * GET  /api/distributor/insights/rep/:id?from&to   — per-rep scorecard + archetype
 * GET  /api/distributor/insights/team?from&to      — leaderboard, heatmap, trend
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

const DEFAULT_DAYS = 30;

function parseTs(s: string | undefined): Date {
  if (s) { const d = new Date(s); if (!Number.isNaN(d.getTime())) return d; }
  return new Date();
}

function defaultRange(query: { from?: string; to?: string }): { from: Date; to: Date } {
  const to   = parseTs(query.to);
  const from = query.from ? parseTs(query.from) : new Date(to.getTime() - DEFAULT_DAYS * 86400_000);
  return { from, to };
}

/** Derive a one-line archetype label from scorecard metrics. */
function archetype(
  hunterIndex: number,
  topCategoryPct: number,
  uniqueAreas: number,
): string {
  const labels: string[] = [];
  labels.push(hunterIndex >= 50 ? "Hunter" : "Maintainer");
  if (topCategoryPct >= 60) labels.push("Specialist");
  labels.push(uniqueAreas <= 2 ? "Anchored" : "Roamer");
  return labels.join("/");
}

export async function distributorInsightsRoutes(app: FastifyInstance): Promise<void> {
  // ── Per-rep scorecard ─────────────────────────────────────────────────────
  app.get<{
    Params: { id: string };
    Querystring: { from?: string; to?: string };
  }>("/api/distributor/insights/rep/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const rep_id = Number(request.params.id);
    if (!Number.isInteger(rep_id) || rep_id < 1)
      return reply.code(400).send({ error: "Invalid rep id." });

    const { from, to } = defaultRange(request.query);

    // Base scorecard
    const [base] = await db<{
      full_name: string; code: string;
      total_visits: string; active_days: string;
      new_visits: string; unique_stores: string; notes_ok: string;
    }[]>`
      select
        s.full_name, s.code,
        count(v.id)::text                                                       as total_visits,
        count(distinct date(v.visited_at at time zone 'Asia/Jakarta'))::text    as active_days,
        count(*) filter (where v.customer_type = 'new')::text                  as new_visits,
        count(distinct v.customer_id)::text                                     as unique_stores,
        count(*) filter (where length(coalesce(v.notes,'')) >= 40)::text        as notes_ok
      from distributor_salespeople s
      left join distributor_visits v on v.salesperson_id = s.id
        and v.visited_at >= ${from} and v.visited_at <= ${to}
      where s.id = ${rep_id}
      group by s.id, s.full_name, s.code
    `;
    if (!base) return reply.code(404).send({ error: "Salesperson not found." });

    const totalVisits = Number(base.total_visits);
    const activeDays  = Number(base.active_days);
    const newVisits   = Number(base.new_visits);
    const uniqueStores = Number(base.unique_stores);
    const notesOk     = Number(base.notes_ok);

    // Category mix
    const catMix = await db<{ category: string; cnt: string }[]>`
      select category, count(*)::text as cnt
      from distributor_visits
      where salesperson_id = ${rep_id}
        and visited_at >= ${from} and visited_at <= ${to}
      group by category
      order by count(*) desc
    `;

    // Area coverage
    const areaMix = await db<{ area: string; cnt: string }[]>`
      select area, count(*)::text as cnt
      from distributor_visits
      where salesperson_id = ${rep_id}
        and visited_at >= ${from} and visited_at <= ${to}
      group by area
      order by count(*) desc
    `;

    // Hourly histogram (WIB)
    const hourly = await db<{ hour: string; cnt: string }[]>`
      select
        extract(hour from visited_at at time zone 'Asia/Jakarta')::text as hour,
        count(*)::text as cnt
      from distributor_visits
      where salesperson_id = ${rep_id}
        and visited_at >= ${from} and visited_at <= ${to}
      group by hour
      order by hour
    `;

    // Pipeline stage counts for owned project accounts
    // Repeating health computed dynamically from visit recency (decay):
    //   <10 days = aktif, 10–13 = perlu_followup, 14–16 = at_risk, 17+ = hibernasi
    const [projectStages, repeatingStages] = await Promise.all([
      db<{ stage: string; cnt: number }[]>`
        select stage, count(*)::int as cnt
        from distributor_customers
        where owner_id = ${rep_id} and account_type = 'project'
        group by stage
      `,
      // Derived from customers.last_contact_at (the single source of truth
      // GET /api/accounts and My Day already use), not visits.visited_at —
      // that earlier version silently included account_type = 'project'
      // customers (visits.customer_id doesn't distinguish account type,
      // and account_type='project' pipeline accounts don't have an
      // aktif/perlu_followup/at_risk/hibernasi concept at all) and used
      // "this rep's own last visit" rather than the account's true last
      // contact, both of which could disagree with My Day for the same
      // rep on the same day.
      db<{ health: string; cnt: number }[]>`
        select
          case
            when last_contact_at is null then 'hibernasi'
            when extract(epoch from (now() - last_contact_at)) / 86400 < 10 then 'aktif'
            when extract(epoch from (now() - last_contact_at)) / 86400 < 14 then 'perlu_followup'
            when extract(epoch from (now() - last_contact_at)) / 86400 < 17 then 'at_risk'
            else 'hibernasi'
          end as health,
          count(*)::int as cnt
        from distributor_customers
        where owner_id = ${rep_id} and account_type = 'repeating'
        group by 1
      `,
    ]);

    const hunterIndex = totalVisits > 0 ? Math.round((newVisits / totalVisits) * 1000) / 10 : 0;
    const topCategoryPct = totalVisits > 0 && catMix[0]
      ? Math.round((Number(catMix[0].cnt) / totalVisits) * 1000) / 10 : 0;
    const uniqueAreas = areaMix.length;
    const topAreaPct = totalVisits > 0 && areaMix[0]
      ? Math.round((Number(areaMix[0].cnt) / totalVisits) * 1000) / 10 : 0;

    const archetypeLabel = archetype(hunterIndex, topCategoryPct, uniqueAreas);

    return {
      rep_id,
      full_name:   base.full_name,
      code:        base.code,
      period:      { from, to },
      scorecard: {
        total_visits:          totalVisits,
        active_days:           activeDays,
        visits_per_active_day: activeDays > 0 ? Math.round((totalVisits / activeDays) * 10) / 10 : 0,
        hunter_index:          hunterIndex,
        unique_stores:         uniqueStores,
        notes_discipline:      totalVisits > 0 ? Math.round((notesOk / totalVisits) * 1000) / 10 : 0,
        top_area_pct:          topAreaPct,
        unique_areas:          uniqueAreas,
      },
      archetype:    archetypeLabel,
      category_mix: catMix.map((r) => ({
        category: r.category,
        count:    Number(r.cnt),
        pct:      totalVisits > 0 ? Math.round((Number(r.cnt) / totalVisits) * 1000) / 10 : 0,
      })),
      area_mix: areaMix.map((r) => ({
        area:  r.area,
        count: Number(r.cnt),
        pct:   totalVisits > 0 ? Math.round((Number(r.cnt) / totalVisits) * 1000) / 10 : 0,
      })),
      hourly_histogram: hourly.map((r) => ({ hour: Number(r.hour), count: Number(r.cnt) })),
      project_stage_counts:   Object.fromEntries(projectStages.map((r) => [r.stage, r.cnt])),
      repeating_stage_counts: Object.fromEntries(repeatingStages.map((r) => [r.health, r.cnt])),
    };
  });

  // ── Team views ────────────────────────────────────────────────────────────
  app.get<{ Querystring: { from?: string; to?: string } }>("/api/distributor/insights/team", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const { from, to } = defaultRange(request.query);

    // Leaderboard: visits + new customers
    const leaderboard = await db<{
      rep_id: string; full_name: string; code: string;
      total_visits: string; new_customers: string; unique_stores: string;
      hunter_index: string;
    }[]>`
      select
        s.id::text as rep_id, s.full_name, s.code,
        count(v.id)::text                                                     as total_visits,
        count(*) filter (where v.customer_type = 'new')::text                 as new_customers,
        count(distinct v.customer_id)::text                                   as unique_stores,
        round(
          count(*) filter (where v.customer_type = 'new')::numeric /
          nullif(count(v.id), 0) * 100, 1
        )::text as hunter_index
      from distributor_salespeople s
      left join distributor_visits v on v.salesperson_id = s.id
        and v.visited_at >= ${from} and v.visited_at <= ${to}
      where s.active = true
      group by s.id, s.full_name, s.code
      order by count(v.id) desc
    `;

    // Coverage heatmap: area × category visit counts
    const heatmap = await db<{ area: string; category: string; cnt: string }[]>`
      select area, category, count(*)::text as cnt
      from distributor_visits
      where visited_at >= ${from} and visited_at <= ${to}
      group by area, category
      order by area, count(*) desc
    `;

    // Team totals + pipeline + decay-based repeating health
    const [[totals], projectStageRows, repeatingHealthRows] = await Promise.all([
      db<{
        total_visits: string; new_visits: string; unique_stores: string; active_reps: string;
      }[]>`
        select
          count(v.id)::text                                              as total_visits,
          count(*) filter (where v.customer_type = 'new')::text         as new_visits,
          count(distinct v.customer_id)::text                            as unique_stores,
          count(distinct v.salesperson_id)::text                         as active_reps
        from distributor_visits v
        where v.visited_at >= ${from} and v.visited_at <= ${to}
      `,
      db<{ stage: string; cnt: number }[]>`
        select stage, count(*)::int as cnt
        from distributor_customers
        where account_type = 'project'
        group by stage
      `,
      // See the per-rep query above for why this is derived from
      // customers.last_contact_at (account_type = 'repeating' only)
      // rather than visits.visited_at.
      db<{ health: string; cnt: number }[]>`
        select
          case
            when last_contact_at is null then 'hibernasi'
            when extract(epoch from (now() - last_contact_at)) / 86400 < 10 then 'aktif'
            when extract(epoch from (now() - last_contact_at)) / 86400 < 14 then 'perlu_followup'
            when extract(epoch from (now() - last_contact_at)) / 86400 < 17 then 'at_risk'
            else 'hibernasi'
          end as health,
          count(*)::int as cnt
        from distributor_customers
        where account_type = 'repeating'
        group by 1
      `,
    ]);

    const projectStageCounts:   Record<string, number> = Object.fromEntries(projectStageRows.map((r) => [r.stage, r.cnt]));
    const repeatingStageCounts: Record<string, number> = Object.fromEntries(repeatingHealthRows.map((r) => [r.health, r.cnt]));

    return {
      period: { from, to },
      totals: {
        total_visits:  Number(totals?.total_visits  ?? 0),
        new_visits:    Number(totals?.new_visits    ?? 0),
        unique_stores: Number(totals?.unique_stores ?? 0),
        active_reps:   Number(totals?.active_reps   ?? 0),
      },
      leaderboard: leaderboard.map((r) => ({
        rep_id:        Number(r.rep_id),
        full_name:     r.full_name,
        code:          r.code,
        total_visits:  Number(r.total_visits),
        new_customers: Number(r.new_customers),
        unique_stores: Number(r.unique_stores),
        hunter_index:  Number(r.hunter_index ?? 0),
      })),
      heatmap: heatmap.map((r) => ({ area: r.area, category: r.category, count: Number(r.cnt) })),
      project_stage_counts:   projectStageCounts,
      repeating_stage_counts: repeatingStageCounts,
    };
  });
}
