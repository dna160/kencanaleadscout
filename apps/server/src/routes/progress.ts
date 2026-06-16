/**
 * [A] GET /api/progress/:id — Server-Sent Events stream of job progress.
 *
 * Emits `{ done, total, found, status }` ~every second until the job finishes
 * (or errors), then sends a final event and closes.
 */
import type { FastifyInstance } from "fastify";
import { getJob } from "../jobs/jobStore.js";

export async function progressRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { id: string } }>("/api/progress/:id", (request, reply) => {
    const { id } = request.params;
    const job = getJob(id);
    if (!job) {
      return reply.code(404).send({ error: "Unknown job id." });
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const send = () => {
      const j = getJob(id);
      if (!j) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: "job gone" })}\n\n`);
        clearInterval(timer);
        reply.raw.end();
        return;
      }
      reply.raw.write(
        `data: ${JSON.stringify({
          done: j.done,
          total: j.total,
          found: j.found,
          status: j.status,
          error: j.error,
        })}\n\n`,
      );
      if (j.status === "done" || j.status === "error") {
        clearInterval(timer);
        reply.raw.end();
      }
    };

    const timer = setInterval(send, 1000);
    send(); // emit immediately

    request.raw.on("close", () => clearInterval(timer));
  });
}
