/**
 * Kabar Pesanan — the Pengiriman tab (PRD §20).
 *
 * GET  /api/notify/dispatch?date=YYYY-MM-DD   deliveries for that WIB day (default today)
 * POST /api/notify/dispatch/mark              {doIds[], action: departed|delayed, date?}   [token]
 * POST /api/notify/dispatch/undo              {doId}                                       [token]
 * PUT  /api/notify/dispatch/settings          {remindHour, remindNumbers[]}                [token]
 *
 * Writes record who acted from `x-notify-actor` (the name typed on /notify).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeNumber } from "@kencana/core";
import { config } from "../config.js";
import { getSql } from "../db/client.js";
import { DispatchError, listDispatch, markDispatch, undoDispatch } from "../notify/dispatch.js";
import { wibDate } from "../notify/rules.js";

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  const required = config.notify.adminToken;
  if (!required) return true;
  if (req.headers["x-notify-token"] === required) return true;
  void reply.code(401).send({ error: "Token admin Kabar Pesanan salah atau belum diisi." });
  return false;
}

function actor(req: FastifyRequest): string {
  const a = req.headers["x-notify-actor"];
  return typeof a === "string" && a.trim() ? a.trim().slice(0, 60) : "admin";
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function notifyDispatchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notify/dispatch", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const today = wibDate(new Date());
    const q = (req.query as { date?: string }).date;
    const date = typeof q === "string" && ISO.test(q) ? q : today;
    const [rows, [s]] = await Promise.all([
      listDispatch(db, date),
      db<{ hour: number; numbers: string[]; reminded_on: string | null }[]>`
        select dispatch_remind_hour as hour, dispatch_remind_numbers as numbers,
               to_char(dispatch_reminded_on, 'YYYY-MM-DD') as reminded_on
          from notify_settings where id = 1`,
    ]);
    return {
      date,
      today,
      mode: config.notify.live,
      remind: { hour: s?.hour ?? 13, numbers: s?.numbers ?? [], remindedOn: s?.reminded_on ?? null },
      rows,
    };
  });

  app.post("/api/notify/dispatch/mark", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const body = (req.body ?? {}) as { doIds?: unknown; action?: unknown; date?: unknown };
    const ids = Array.isArray(body.doIds) ? body.doIds.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    if (!ids.length || ids.length > 200) return reply.code(400).send({ error: "Pilih 1–200 surat jalan." });
    if (body.action !== "departed" && body.action !== "delayed") {
      return reply.code(400).send({ error: "action harus departed atau delayed." });
    }
    const date = body.date == null || body.date === "" ? null : body.date;
    if (date !== null && (typeof date !== "string" || !ISO.test(date))) {
      return reply.code(400).send({ error: "Tanggal baru harus berformat YYYY-MM-DD." });
    }
    const by = actor(req);
    const now = new Date();
    const results = [];
    for (const doId of [...new Set(ids)]) {
      try {
        const r = await markDispatch(db, {
          doId,
          action: body.action === "departed" ? "departed" : "rescheduled",
          toDate: date as string | null,
          source: "staff",
          by,
          now,
        });
        results.push({ ...r, ok: true });
      } catch (err) {
        if (!(err instanceof DispatchError)) throw err;
        results.push({ doId, ok: false, error: err.message });
      }
    }
    req.log.info({ actor: by, action: body.action, date, n: ids.length, ok: results.filter((r) => r.ok).length }, "dispatch marked");
    return { results };
  });

  app.post("/api/notify/dispatch/undo", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const doId = (req.body as { doId?: unknown } | null)?.doId;
    if (typeof doId !== "string" || !doId) return reply.code(400).send({ error: "doId wajib diisi." });
    try {
      const r = await undoDispatch(db, doId, actor(req));
      req.log.info({ actor: actor(req), doId }, "dispatch mark undone");
      return { ok: true, ...r };
    } catch (err) {
      if (err instanceof DispatchError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.put("/api/notify/dispatch/settings", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const body = (req.body ?? {}) as { remindHour?: unknown; remindNumbers?: unknown };
    const hour = Number(body.remindHour);
    if (!Number.isInteger(hour) || hour < -1 || hour > 23) {
      return reply.code(400).send({ error: "Jam pengingat harus 0–23 (atau -1 untuk mematikan)." });
    }
    const raw = Array.isArray(body.remindNumbers) ? body.remindNumbers : [];
    const numbers: string[] = [];
    for (const n of raw) {
      if (typeof n !== "string" || !n.trim()) continue;
      const e = normalizeNumber(n.trim());
      if (!e) return reply.code(400).send({ error: `${n} bukan nomor HP Indonesia yang valid.` });
      if (!numbers.includes(e)) numbers.push(e);
    }
    if (numbers.length > 10) return reply.code(400).send({ error: "Paling banyak 10 nomor." });
    await db`
      update notify_settings set dispatch_remind_hour = ${hour}, dispatch_remind_numbers = ${numbers}, updated_at = now()
       where id = 1`;
    req.log.info({ actor: actor(req), hour, n: numbers.length }, "dispatch reminder settings changed");
    return { hour, numbers };
  });
}
