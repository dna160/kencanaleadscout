import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";
import { seedSyHunter } from "../db/seedSyHunter.js";

const VALID_STAGES = new Set(["fresh", "called", "interested", "meeting_set", "won", "dead"]);

export async function syHunterRoutes(app: FastifyInstance) {
  // ── Seed on first request if tables are empty ──────────────────────────────
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

  // ── GET /api/sy/contacts ───────────────────────────────────────────────────
  // Returns contacts joined to their pipeline row, with optional filters.
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
        c.project_name, c.province, c.town, c.timing, c.source,
        coalesce(p.stage, 'fresh')  as stage,
        p.note, p.meeting_at, p.called_at, p.interested_at, p.updated_at
      from sy_contacts c
      left join sy_pipeline p on p.contact_id = c.id
      where c.active = true
        ${priority ? db`and c.priority = ${priority}` : db``}
        ${band     ? db`and c.band     = ${band}`     : db``}
        ${timing   ? db`and c.timing   = ${timing}`   : db``}
        ${stage === "fresh"
          ? db`and (p.stage = 'fresh' or p.stage is null)`
          : stage
          ? db`and p.stage = ${stage}`
          : db``}
        ${search   ? db`and (lower(c.company_name) like ${"%" + search.toLowerCase() + "%"}
                          or lower(c.contact_name) like ${"%" + search.toLowerCase() + "%"}
                          or lower(c.project_name) like ${"%" + search.toLowerCase() + "%"})` : db``}
      order by
        case c.priority when 'P1' then 1 when 'P2' then 2 else 3 end,
        case c.band when 'A' then 1 when 'B' then 2 else 3 end,
        case c.timing
          when 'HOT-building now'      then 1
          when 'HOT-buying envelope'   then 2
          when 'WARM-spec-in window'   then 3
          else 4
        end,
        coalesce(c.score, 0) desc,
        c.id
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
        ${stage === "fresh"
          ? db`and (p.stage = 'fresh' or p.stage is null)`
          : stage
          ? db`and p.stage = ${stage}`
          : db``}
        ${search   ? db`and (lower(c.company_name) like ${"%" + search.toLowerCase() + "%"}
                          or lower(c.contact_name) like ${"%" + search.toLowerCase() + "%"}
                          or lower(c.project_name) like ${"%" + search.toLowerCase() + "%"})` : db``}
    `;
    const total = Number(totalRows[0]?.total ?? 0);

    return { contacts: rows, total, limit, offset };
  });

  // ── PATCH /api/sy/pipeline/:id ─────────────────────────────────────────────
  // Upsert pipeline row for a contact. Body: { stage, note?, meeting_at? }
  app.patch<{
    Params: { id: string };
    Body: { stage?: string; note?: string; meeting_at?: string | null };
  }>("/api/sy/pipeline/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const contactId = Number(request.params.id);
    if (!contactId) return reply.code(400).send({ error: "Invalid contact id." });

    const { stage, note, meeting_at } = request.body ?? {};
    if (stage !== undefined && !VALID_STAGES.has(stage)) {
      return reply.code(400).send({ error: "Invalid stage." });
    }

    const now = new Date().toISOString();
    const calledAt     = stage === "called"      ? now : undefined;
    const interestedAt = stage === "interested"  ? now : undefined;

    const meetingVal  = meeting_at !== undefined ? (meeting_at ?? null) : null;
    const noteVal     = note !== undefined ? (note ?? null) : null;

    const rows2 = await db`
      insert into sy_pipeline (contact_id, stage, note, meeting_at, called_at, interested_at, updated_at)
      values (
        ${contactId},
        ${stage ?? "fresh"},
        ${noteVal},
        ${meetingVal},
        ${calledAt ?? null},
        ${interestedAt ?? null},
        now()
      )
      on conflict (contact_id) do update set
        stage         = coalesce(${stage ?? null},        sy_pipeline.stage),
        note          = case when ${noteVal} is not null    then ${noteVal}    else sy_pipeline.note    end,
        meeting_at    = case when ${meetingVal} is not null then ${meetingVal} else sy_pipeline.meeting_at end,
        called_at     = coalesce(${calledAt ?? null},     sy_pipeline.called_at),
        interested_at = coalesce(${interestedAt ?? null}, sy_pipeline.interested_at),
        updated_at    = now()
      returning *
    `;

    return { ok: true, pipeline: rows2[0] };
  });

  // ── GET /api/sy/champion ───────────────────────────────────────────────────
  // Aggregate stats for the champion dashboard.
  app.get("/api/sy/champion", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    await ensureSeeded();

    // Stage counts across all contacts
    const stageCounts = await db`
      select
        coalesce(p.stage, 'fresh') as stage,
        count(*)::int as cnt
      from sy_contacts c
      left join sy_pipeline p on p.contact_id = c.id
      where c.active = true
      group by coalesce(p.stage, 'fresh')
    `;

    // Per-priority breakdown
    const byPriority = await db`
      select
        c.priority,
        coalesce(p.stage, 'fresh') as stage,
        count(*)::int as cnt
      from sy_contacts c
      left join sy_pipeline p on p.contact_id = c.id
      where c.active = true
      group by c.priority, coalesce(p.stage, 'fresh')
      order by c.priority
    `;

    // Per-band breakdown
    const byBand = await db`
      select
        c.band,
        coalesce(p.stage, 'fresh') as stage,
        count(*)::int as cnt
      from sy_contacts c
      left join sy_pipeline p on p.contact_id = c.id
      where c.active = true
      group by c.band, coalesce(p.stage, 'fresh')
      order by c.band
    `;

    // Recent pipeline activity (last 50 updates)
    const recentActivity = await db`
      select
        c.company_name, c.contact_name, c.project_name, c.priority, c.timing,
        p.stage, p.updated_at, p.note
      from sy_pipeline p
      join sy_contacts c on c.id = p.contact_id
      where p.stage <> 'fresh'
      order by p.updated_at desc
      limit 50
    `;

    // Top projects by active pipeline contacts
    const topProjects = await db`
      select
        c.project_name,
        count(*)::int as total_contacts,
        count(*) filter (where coalesce(p.stage,'fresh') not in ('fresh','dead'))::int as active_contacts
      from sy_contacts c
      left join sy_pipeline p on p.contact_id = c.id
      where c.active = true and c.project_name is not null
      group by c.project_name
      having count(*) filter (where coalesce(p.stage,'fresh') not in ('fresh','dead')) > 0
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
