import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";
import { seedSyHunter } from "../db/seedSyHunter.js";

const VALID_OUTCOME  = new Set(["won_wa", "warm", "not_interested", "no_answer", "dead"]);
const VALID_PIPELINE = new Set(["fresh", "messaged", "replied", "meeting_set", "won", "dead"]);
const PREV_STAGE: Record<string, string> = {
  messaged: "fresh", replied: "messaged", meeting_set: "replied", won: "meeting_set",
};

export async function syHunterRoutes(app: FastifyInstance) {
  let seeded = false;
  async function ensureSeeded() {
    if (seeded) return;
    const db = getSql();
    if (!db) return;
    const cntRows = await db`select count(*)::int as cnt from sy_contacts`;
    if (Number(cntRows[0]?.cnt ?? 0) === 0) {
      try {
        const r = await seedSyHunter(db);
        app.log.info(r, "[sy-hunter] seed complete");
      } catch (err) {
        app.log.error({ err }, "[sy-hunter] seed failed");
      }
    }
    seeded = true;
  }

  // ── GET /api/sy/leads?day=N ────────────────────────────────────────────────
  app.get<{ Querystring: { day?: string } }>("/api/sy/leads", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    await ensureSeeded();

    const day = Number(request.query.day ?? 0);
    if (!day || day < 1 || day > 10) return reply.code(400).send({ error: "day must be 1–10" });

    const rows = await db`
      select
        c.id, c.priority, c.band, c.score, c.company_name, c.role,
        c.contact_name, c.position, c.phone, c.phone_clean, c.email,
        c.project_name, c.province, c.town, c.timing, c.source, c.day,
        row_to_json(o.*) as outcome
      from sy_contacts c
      left join sy_outcomes o on o.contact_id = c.id
      where c.active = true and c.day = ${day}
      order by
        case c.priority when 'P1' then 1 when 'P2' then 2 else 3 end,
        case c.band     when 'A'  then 1 when 'B'  then 2 else 3 end,
        coalesce(c.score, 0) desc, c.id
    `;
    return { leads: rows };
  });

  // ── POST /api/sy/outcome ───────────────────────────────────────────────────
  app.post<{
    Body: {
      contact_id: number; status: string;
      wa_number?: string | null; pic_name?: string | null;
      sample_sent?: boolean; updated_by?: string;
    };
  }>("/api/sy/outcome", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const { contact_id, status, wa_number, pic_name, sample_sent, updated_by } = request.body ?? {};
    if (!contact_id || !status) return reply.code(400).send({ error: "contact_id and status required." });
    if (!VALID_OUTCOME.has(status)) return reply.code(400).send({ error: "Invalid status." });

    const waVal      = wa_number?.trim()  || null;
    const picVal     = pic_name?.trim()   || null;
    const sampleVal  = sample_sent === true;
    const updatedBy  = updated_by || null;

    await db`
      insert into sy_outcomes (contact_id, status, wa_number, pic_name, sample_sent, updated_by, updated_at)
      values (${contact_id}, ${status}, ${waVal}, ${picVal}, ${sampleVal}, ${updatedBy}, now())
      on conflict (contact_id) do update set
        status      = ${status},
        wa_number   = coalesce(${waVal}, sy_outcomes.wa_number),
        pic_name    = coalesce(${picVal}, sy_outcomes.pic_name),
        sample_sent = ${sampleVal},
        updated_by  = ${updatedBy},
        updated_at  = now()
    `;

    if (status === "won_wa" || status === "warm") {
      await db`
        insert into sy_pipeline (contact_id, stage, called_at, updated_at)
        values (${contact_id}, 'fresh', now(), now())
        on conflict (contact_id) do nothing
      `;
    }

    return { ok: true };
  });

  // ── GET /api/sy/stats ──────────────────────────────────────────────────────
  app.get("/api/sy/stats", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    await ensureSeeded();

    const totRows = await db`
      select
        count(*) filter (where o.status is not null)::int             as dialed,
        (select count(*)::int from sy_contacts where active = true)   as assigned,
        count(*) filter (where o.status = 'won_wa')::int              as captured,
        count(*) filter (where o.status = 'warm')::int                as warm
      from sy_contacts c
      left join sy_outcomes o on o.contact_id = c.id
      where c.active = true
    `;

    const byDay = await db`
      select
        c.day,
        count(*) filter (where o.status is not null)::int  as dialed,
        count(*) filter (where o.status = 'won_wa')::int   as captured
      from sy_contacts c
      left join sy_outcomes o on o.contact_id = c.id
      where c.active = true
      group by c.day
      order by c.day
    `;

    const byPriority = await db`
      select
        c.priority,
        count(*)::int                                       as total,
        count(*) filter (where o.status is not null)::int  as dialed,
        count(*) filter (where o.status = 'won_wa')::int   as captured
      from sy_contacts c
      left join sy_outcomes o on o.contact_id = c.id
      where c.active = true
      group by c.priority
      order by c.priority
    `;

    const byBand = await db`
      select
        c.band,
        count(*)::int                                       as total,
        count(*) filter (where o.status is not null)::int  as dialed,
        count(*) filter (where o.status = 'won_wa')::int   as captured
      from sy_contacts c
      left join sy_outcomes o on o.contact_id = c.id
      where c.active = true
      group by c.band
      order by c.band
    `;

    const recent = await db`
      select
        c.company_name, c.contact_name, c.priority, c.band, c.timing, c.project_name,
        o.status, o.wa_number, o.pic_name, o.updated_by, o.updated_at
      from sy_outcomes o
      join sy_contacts c on c.id = o.contact_id
      where o.status in ('won_wa', 'warm')
      order by o.updated_at desc
      limit 15
    `;

    const t       = totRows[0];
    const dialed   = Number(t?.dialed   ?? 0);
    const captured = Number(t?.captured ?? 0);
    return {
      totals: {
        dialed,
        assigned:      Number(t?.assigned ?? 0),
        captured,
        warm:          Number(t?.warm     ?? 0),
        capture_rate:  dialed ? captured / dialed : 0,
      },
      by_day:      byDay,
      by_priority: byPriority,
      by_band:     byBand,
      recent,
    };
  });

  // ── GET /api/sy/pipeline ───────────────────────────────────────────────────
  app.get("/api/sy/pipeline", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    await ensureSeeded();

    const rows = await db`
      select
        c.id as contact_id, c.company_name, c.priority, c.band, c.score,
        c.contact_name, c.position, c.phone, c.email,
        c.project_name, c.province, c.town, c.timing,
        p.stage, p.pipe_note, p.meeting_at,
        p.called_at as captured_at, p.messaged_at, p.replied_at, p.updated_at,
        o.status as outcome_status, o.note as outcome_note
      from sy_pipeline p
      join sy_contacts c on c.id = p.contact_id
      left join sy_outcomes o on o.contact_id = c.id
      where p.stage not in ('won','dead')
         or p.updated_at > now() - interval '14 days'
      order by
        case p.stage
          when 'fresh'       then 1
          when 'messaged'    then 2
          when 'replied'     then 3
          when 'meeting_set' then 4
          when 'won'         then 5
          else 6
        end,
        p.updated_at desc nulls last
      limit 300
    `;
    return { items: rows };
  });

  // ── POST /api/sy/pipeline/advance ─────────────────────────────────────────
  app.post<{
    Body: { contact_id: number; to_stage: string; meeting_at?: string | null; pipe_note?: string };
  }>("/api/sy/pipeline/advance", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const { contact_id, to_stage, meeting_at, pipe_note } = request.body ?? {};
    if (!contact_id || !to_stage)   return reply.code(400).send({ error: "contact_id and to_stage required." });
    if (!VALID_PIPELINE.has(to_stage)) return reply.code(400).send({ error: "Invalid stage." });

    const now        = new Date().toISOString();
    const messagedAt = to_stage === "messaged" ? now : null;
    const repliedAt  = to_stage === "replied"  ? now : null;
    const meetingVal = meeting_at ?? null;
    const noteVal    = pipe_note  ?? null;

    await db`
      insert into sy_pipeline
        (contact_id, stage, messaged_at, replied_at, meeting_at, pipe_note, updated_at)
      values
        (${contact_id}, ${to_stage},
         ${messagedAt}, ${repliedAt}, ${meetingVal}, ${noteVal}, now())
      on conflict (contact_id) do update set
        stage       = ${to_stage},
        messaged_at = coalesce(${messagedAt}, sy_pipeline.messaged_at),
        replied_at  = coalesce(${repliedAt},  sy_pipeline.replied_at),
        meeting_at  = coalesce(${meetingVal}, sy_pipeline.meeting_at),
        pipe_note   = case when ${noteVal} is not null then ${noteVal} else sy_pipeline.pipe_note end,
        updated_at  = now()
    `;
    return { ok: true };
  });

  // ── POST /api/sy/pipeline/revert ──────────────────────────────────────────
  app.post<{ Body: { contact_id: number } }>("/api/sy/pipeline/revert", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const { contact_id } = request.body ?? {};
    if (!contact_id) return reply.code(400).send({ error: "contact_id required." });

    const pRows = await db`select stage from sy_pipeline where contact_id = ${contact_id}`;
    if (!pRows.length) return reply.code(404).send({ error: "Not found." });
    const prev = PREV_STAGE[(pRows[0]?.stage ?? "") as string];
    if (!prev) return reply.code(400).send({ error: "Cannot revert from this stage." });

    await db`update sy_pipeline set stage = ${prev}, updated_at = now() where contact_id = ${contact_id}`;
    return { ok: true };
  });

  // ── GET /api/sy/contacts ───────────────────────────────────────────────────
  app.get<{
    Querystring: {
      priority?: string; band?: string; timing?: string;
      stage?: string; search?: string; limit?: string; offset?: string;
    };
  }>("/api/sy/contacts", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    await ensureSeeded();

    const { priority, band, timing, stage, search } = request.query;
    const limit  = Math.min(Number(request.query.limit  ?? 200), 500);
    const offset = Number(request.query.offset ?? 0);

    const rows = await db`
      select
        c.id, c.priority, c.band, c.score, c.company_name, c.role,
        c.contact_name, c.position, c.phone, c.email,
        c.project_name, c.province, c.town, c.timing, c.source, c.day,
        coalesce(p.stage, 'fresh') as stage,
        p.pipe_note as note, p.meeting_at, p.called_at, p.updated_at,
        o.status as outcome_status
      from sy_contacts c
      left join sy_pipeline p on p.contact_id = c.id
      left join sy_outcomes o on o.contact_id = c.id
      where c.active = true
        ${priority ? db`and c.priority = ${priority}` : db``}
        ${band     ? db`and c.band     = ${band}`     : db``}
        ${timing   ? db`and c.timing   = ${timing}`   : db``}
        ${stage    ? db`and coalesce(p.stage,'fresh') = ${stage}` : db``}
        ${search   ? db`and (lower(c.company_name) like ${"%" + search.toLowerCase() + "%"}
                          or lower(c.contact_name) like ${"%" + search.toLowerCase() + "%"}
                          or lower(c.project_name) like ${"%" + search.toLowerCase() + "%"})` : db``}
      order by
        case c.priority when 'P1' then 1 when 'P2' then 2 else 3 end,
        case c.band     when 'A'  then 1 when 'B'  then 2 else 3 end,
        coalesce(c.score, 0) desc, c.id
      limit ${limit} offset ${offset}
    `;

    const totalRows = await db`
      select count(*)::int as total
      from sy_contacts c
      left join sy_pipeline p on p.contact_id = c.id
      where c.active = true
        ${priority ? db`and c.priority = ${priority}` : db``}
        ${band     ? db`and c.band     = ${band}`     : db``}
        ${timing   ? db`and c.timing   = ${timing}`   : db``}
        ${stage    ? db`and coalesce(p.stage,'fresh') = ${stage}` : db``}
        ${search   ? db`and (lower(c.company_name) like ${"%" + search.toLowerCase() + "%"}
                          or lower(c.contact_name) like ${"%" + search.toLowerCase() + "%"}
                          or lower(c.project_name) like ${"%" + search.toLowerCase() + "%"})` : db``}
    `;
    return { contacts: rows, total: Number(totalRows[0]?.total ?? 0), limit, offset };
  });

  // ── GET /api/sy/champion ───────────────────────────────────────────────────
  app.get("/api/sy/champion", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    await ensureSeeded();

    const stageCounts = await db`
      select coalesce(p.stage,'fresh') as stage, count(*)::int as cnt
      from sy_contacts c
      left join sy_pipeline p on p.contact_id = c.id
      where c.active = true
      group by coalesce(p.stage,'fresh')
    `;
    const byPriority = await db`
      select c.priority, coalesce(p.stage,'fresh') as stage, count(*)::int as cnt
      from sy_contacts c
      left join sy_pipeline p on p.contact_id = c.id
      where c.active = true
      group by c.priority, coalesce(p.stage,'fresh')
      order by c.priority
    `;
    const byBand = await db`
      select c.band, coalesce(p.stage,'fresh') as stage, count(*)::int as cnt
      from sy_contacts c
      left join sy_pipeline p on p.contact_id = c.id
      where c.active = true
      group by c.band, coalesce(p.stage,'fresh')
      order by c.band
    `;
    const recentActivity = await db`
      select c.company_name, c.contact_name, c.project_name, c.priority, c.timing,
             p.stage, p.updated_at, p.pipe_note as note
      from sy_pipeline p
      join sy_contacts c on c.id = p.contact_id
      where p.stage <> 'fresh'
      order by p.updated_at desc
      limit 50
    `;
    const topProjects = await db`
      select c.project_name,
             count(*)::int as total_contacts,
             count(*) filter (where o.status in ('won_wa','warm'))::int as active_contacts
      from sy_contacts c
      left join sy_outcomes o on o.contact_id = c.id
      where c.active = true and c.project_name is not null
      group by c.project_name
      having count(*) filter (where o.status in ('won_wa','warm')) > 0
      order by active_contacts desc
      limit 10
    `;

    return { stageCounts, byPriority, byBand, recentActivity, topProjects };
  });

  // ── GET /api/sy/projects ───────────────────────────────────────────────────
  app.get("/api/sy/projects", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    await ensureSeeded();
    const rows = await db`
      select * from sy_projects where active = true
      order by coalesce(rank, 9999), coalesce(score, 0) desc
      limit 300
    `;
    return { projects: rows };
  });
}
