/**
 * [A] GET /api/result/:id — stream the enriched .xlsx as an attachment.
 */
import type { FastifyInstance } from "fastify";
import { getJob } from "../jobs/jobStore.js";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function downloadName(original: string): string {
  const base = original.replace(/\.(xlsx|xls|csv)$/i, "").replace(/[^\w.-]+/g, "_") || "accounts";
  return `${base}_enriched.xlsx`;
}

export async function resultRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/result/:id", (request, reply) => {
    const job = getJob(request.params.id);
    if (!job) return reply.code(404).send({ error: "Unknown job id." });
    if (job.status === "error") return reply.code(500).send({ error: job.error });
    if (job.status !== "done" || !job.result) {
      return reply.code(409).send({ error: "Job not finished yet." });
    }

    return reply
      .header("Content-Type", XLSX_MIME)
      .header("Content-Disposition", `attachment; filename="${downloadName(job.filename)}"`)
      .send(job.result);
  });
}
