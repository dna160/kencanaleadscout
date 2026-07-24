/**
 * [D] Salesperson registry routes (microPRD §8).
 *
 * GET    /api/distributor/salespeople           — dropdown source (active=true by default)
 * POST   /api/distributor/salespeople           — Handler+: register
 * PATCH  /api/distributor/salespeople/:id       — Handler+: edit / deactivate
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

export async function distributorSalespeopleRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { active?: string } }>("/api/distributor/salespeople", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const onlyActive = request.query.active !== "false";
    const rows = await db`
      select id, full_name, code, phone_e164, default_area, active, created_at
      from distributor_salespeople
      ${onlyActive ? db`where active = true` : db``}
      order by full_name
    `;
    return { count: rows.length, salespeople: rows };
  });

  app.get<{ Params: { id: string } }>("/api/distributor/salespeople/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const [rep] = await db`select * from distributor_salespeople where id = ${id}`;
    if (!rep) return reply.code(404).send({ error: "Salesperson not found." });
    return { salesperson: rep };
  });

  app.post<{ Body: Record<string, unknown> }>("/api/distributor/salespeople", async (request, reply) => {
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
        insert into distributor_salespeople (full_name, code, phone_e164, default_area)
        values (${full_name}, ${code}, ${phone_e164}, ${default_area})
        returning *
      `;
      return { ok: true, salesperson: saved };
    } catch (err: unknown) {
      app.log.error({ err }, "salespeople insert failed");
      const pgCode = (err as Record<string, unknown>)?.code;
      if (pgCode === "23505") {
        return reply.code(409).send({ error: "Kode ini sudah digunakan salesperson lain. Gunakan kode berbeda atau kosongkan kolom kode." });
      }
      if (pgCode === "42P01") {
        return reply.code(503).send({ error: "Tabel salespeople belum tersedia — server sedang inisialisasi, coba lagi dalam beberapa detik." });
      }
      return reply.code(500).send({ error: "Gagal mendaftarkan salesperson. Lihat log server untuk detail." });
    }
  });

  app.patch<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>("/api/distributor/salespeople/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const b = request.body ?? {};

    const [current] = await db<{ id: number }[]>`
      select id from distributor_salespeople where id = ${id}
    `;
    if (!current) return reply.code(404).send({ error: "Salesperson not found." });

    const full_name    = "full_name"    in b ? String(b.full_name    ?? "").trim() || null : null;
    const code         = "code"         in b ? (b.code ? String(b.code).trim().toUpperCase() : null) : undefined;
    const phone_e164   = "phone_e164"   in b ? (b.phone_e164 ? String(b.phone_e164).trim() : null) : undefined;
    const default_area = "default_area" in b ? (b.default_area ? String(b.default_area).trim() : null) : undefined;
    const active       = "active"       in b ? Boolean(b.active) : undefined;

    const [saved] = await db`
      update distributor_salespeople set
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
