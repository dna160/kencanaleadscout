/**
 * [D] Salesperson registry routes (microPRD §8).
 *
 * GET    /api/salespeople           — dropdown source (active=true by default)
 * POST   /api/salespeople           — Handler+: register
 * PATCH  /api/salespeople/:id       — Handler+: edit / deactivate
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

export async function salespeopleRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { active?: string } }>("/api/salespeople", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const onlyActive = request.query.active !== "false";
    const rows = await db`
      select id, full_name, code, phone_e164, default_area, active, created_at
      from salespeople
      ${onlyActive ? db`where active = true` : db``}
      order by full_name
    `;
    return { count: rows.length, salespeople: rows };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/salespeople", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b           = request.body ?? {};
    const full_name   = String(b.full_name   ?? "").trim();
    const code        = b.code        ? String(b.code).trim().toUpperCase()  : null;
    const phone_e164  = b.phone_e164  ? String(b.phone_e164).trim()          : null;
    const default_area = b.default_area ? String(b.default_area).trim()      : null;

    if (!full_name) return reply.code(400).send({ error: "full_name is required." });

    try {
      const [saved] = await db`
        insert into salespeople (full_name, code, phone_e164, default_area)
        values (${full_name}, ${code}, ${phone_e164}, ${default_area})
        returning *
      `;
      return { ok: true, salesperson: saved };
    } catch (err) {
      app.log.error({ err }, "salespeople insert failed");
      return reply.code(400).send({ error: "Could not register salesperson (code may be taken)." });
    }
  });

  app.patch<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>("/api/salespeople/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const b = request.body ?? {};

    const [current] = await db<{ id: number }[]>`
      select id from salespeople where id = ${id}
    `;
    if (!current) return reply.code(404).send({ error: "Salesperson not found." });

    const full_name    = "full_name"    in b ? String(b.full_name    ?? "").trim() || null : null;
    const code         = "code"         in b ? (b.code ? String(b.code).trim().toUpperCase() : null) : undefined;
    const phone_e164   = "phone_e164"   in b ? (b.phone_e164 ? String(b.phone_e164).trim() : null) : undefined;
    const default_area = "default_area" in b ? (b.default_area ? String(b.default_area).trim() : null) : undefined;
    const active       = "active"       in b ? Boolean(b.active) : undefined;

    const [saved] = await db`
      update salespeople set
        full_name    = ${full_name    != null ? full_name    : db`full_name`},
        code         = ${code        !== undefined ? code        : db`code`},
        phone_e164   = ${phone_e164  !== undefined ? phone_e164  : db`phone_e164`},
        default_area = ${default_area !== undefined ? default_area : db`default_area`},
        active       = ${active      !== undefined ? active      : db`active`}
      where id = ${id}
      returning *
    `;
    return { ok: true, salesperson: saved };
  });
}
