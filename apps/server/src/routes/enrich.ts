/**
 * [A] POST /api/enrich — multipart upload → validate → start an async job.
 *
 * Returns `{ jobId, total }` immediately; the batch runs in the background and
 * progress is observed via SSE (`/api/progress/:id`). On completion the result
 * is also bridged into the `enrichments` table so the cockpit can pre-fill.
 */
import type { FastifyInstance } from "fastify";
import { enrichBatch, type AccountRow } from "@kencana/core";
import { config } from "../config.js";
import { getSql } from "../db/client.js";
import { upsertEnrichments } from "../db/enrichments.js";
import { createJob, failJob, finishJob, updateProgress } from "../jobs/jobStore.js";
import { readSheet, SheetError } from "../io/readSheet.js";
import { writeSheet } from "../io/writeSheet.js";

/** Read a `Company` column case-insensitively (for the enrichment bridge). */
function readCompany(row: AccountRow): string {
  for (const key of Object.keys(row)) {
    if (key.trim().toLowerCase() === "company") {
      const v = row[key];
      return v == null ? "" : String(v);
    }
  }
  return "";
}

export async function enrichRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/enrich", async (request, reply) => {
    const file = await request.file({ limits: { fileSize: config.maxUploadBytes } });
    if (!file) {
      return reply.code(400).send({ error: "No file uploaded. Attach an .xlsx or .csv." });
    }

    const buffer = await file.toBuffer();

    let parsed;
    try {
      parsed = readSheet(buffer);
    } catch (err) {
      const message = err instanceof SheetError ? err.message : "Could not parse the file.";
      return reply.code(400).send({ error: message });
    }

    if (parsed.rows.length === 0) {
      return reply.code(400).send({ error: "The sheet has no data rows." });
    }

    const job = createJob(parsed.rows.length, file.filename || "accounts.xlsx");

    // Fire-and-forget; never block the response on the batch.
    void runJob(app, job.id, parsed.columns, parsed.rows);

    return reply.code(202).send({ jobId: job.id, total: job.total });
  });
}

async function runJob(
  app: FastifyInstance,
  jobId: string,
  columns: string[],
  rows: AccountRow[],
): Promise<void> {
  try {
    const results = await enrichBatch(
      rows,
      {
        concurrency: config.concurrency,
        requestTimeoutMs: config.requestTimeoutMs,
        maxPagesPerSite: config.maxPagesPerSite,
      },
      (p) => updateProgress(jobId, p.done, p.found),
    );

    const buffer = writeSheet(columns, rows, results);
    finishJob(jobId, buffer);
    app.log.info({ jobId, rows: rows.length }, "enrich job complete");

    // Bridge into Postgres so reps see pre-found WA numbers (best-effort).
    const db = getSql();
    if (db) {
      const items = rows.map((row, i) => ({
        company: readCompany(row),
        wa_numbers: results[i]?.wa_numbers ?? [],
        mobile_numbers: results[i]?.mobile_numbers ?? [],
        source: results[i]?.source ?? "none",
        confidence: results[i]?.confidence ?? "",
        pages_checked: results[i]?.pages_checked ?? 0,
      }));
      upsertEnrichments(db, items)
        .then((n) => app.log.info({ jobId, written: n }, "enrichments bridged to db"))
        .catch((err) => app.log.error({ err }, "enrichment bridge failed"));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "enrichment failed";
    app.log.error({ jobId, err }, "enrich job failed");
    failJob(jobId, message);
  }
}
