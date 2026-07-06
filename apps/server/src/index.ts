/**
 * Fastify bootstrap — one service, three surfaces (microPRD §4, §6).
 *
 *   /          landing → links to the three surfaces
 *   /scraper   [A] upload → progress → download
 *   /calls     [B] rep call cockpit (mobile-first)
 *   /champion  [B] live champion dashboard
 *
 * Part A works with no database. Part B routes return 503 until DATABASE_URL is
 * set, so the whole app always boots and stays healthy on Railway.
 */
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { config, hasDatabase } from "./config.js";
import { closeDatabase, getSql, pingDatabase } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { seedLeads } from "./db/seedLeads.js";
import { enrichRoutes } from "./routes/enrich.js";
import { progressRoutes } from "./routes/progress.js";
import { resultRoutes } from "./routes/result.js";
import { leadsRoutes } from "./routes/leads.js";
import { outcomeRoutes } from "./routes/outcome.js";
import { statsRoutes } from "./routes/stats.js";
import { capturesRoutes } from "./routes/captures.js";
import { pipelineRoutes } from "./routes/pipeline.js";
import { salesLeadRoutes } from "./routes/sales-lead.js";
import { visitsRoutes } from "./routes/visits.js";
import { salespeopleRoutes } from "./routes/salespeople.js";
import { listsRoutes } from "./routes/lists.js";
import { insightsRoutes } from "./routes/insights.js";
import { accountsRoutes, startCadenceEngine } from "./routes/accounts.js";
import { escalationsRoutes } from "./routes/escalations.js";
import { miraeRoutes } from "./routes/mirae.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

async function bootDatabase(app: ReturnType<typeof Fastify>): Promise<void> {
  if (!hasDatabase) {
    app.log.warn("DATABASE_URL not set — Part B (call dashboard) disabled; Part A still works.");
    return;
  }
  const db = getSql();
  if (!db) return;
  try {
    await runMigrations(db);
    const n = await seedLeads(db);
    app.log.info({ seeded: n }, "database ready (migrated + seeded)");
  } catch (err) {
    app.log.error({ err }, "database boot failed — Part B will be unavailable");
  }
}

async function main(): Promise<void> {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV === "production"
          ? undefined
          : { target: "pino-pretty", options: { translateTime: "HH:MM:ss", ignore: "pid,hostname" } },
    },
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(fastifyMultipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  });
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/", index: false });

  // Health (also Railway's healthcheck target via "/").
  app.get("/health", async () => ({ ok: true, db: await pingDatabase() }));

  // Surfaces.
  const NC = "no-cache, no-store, must-revalidate";
  app.get("/", (_req, reply) => reply.header("Cache-Control", NC).sendFile("index.html"));
  app.get("/scraper", (_req, reply) => reply.header("Cache-Control", NC).sendFile("scraper.html"));
  app.get("/calls", (_req, reply) => reply.header("Cache-Control", NC).sendFile("calls.html"));
  app.get("/champion", (_req, reply) => reply.header("Cache-Control", NC).sendFile("champion.html"));
  app.get("/handler", (_req, reply) => reply.header("Cache-Control", NC).sendFile("handler.html"));
  app.get("/sales-lead", (_req, reply) => reply.header("Cache-Control", NC).sendFile("sales-lead.html"));
  app.get("/visits", (_req, reply) => reply.header("Cache-Control", NC).sendFile("visits.html"));
  app.get("/visits-rack", (_req, reply) => reply.header("Cache-Control", NC).sendFile("visits-rack.html"));
  app.get("/visits-rep", (_req, reply) => reply.header("Cache-Control", NC).sendFile("visits-rep.html"));
  app.get("/salespeople", (_req, reply) => reply.header("Cache-Control", NC).sendFile("salespeople.html"));
  app.get("/visits-insights", (_req, reply) => reply.header("Cache-Control", NC).sendFile("visits-insights.html"));
  app.get("/myday", (_req, reply) => reply.header("Cache-Control", NC).sendFile("myday.html"));
  app.get("/account", (_req, reply) => reply.header("Cache-Control", NC).sendFile("account.html"));
  app.get("/mirae-visits", (_req, reply) => reply.header("Cache-Control", NC).sendFile("mirae-visits.html"));
  app.get("/mirae-rack", (_req, reply) => reply.header("Cache-Control", NC).sendFile("mirae-rack.html"));
  app.get("/mirae-insights", (_req, reply) => reply.header("Cache-Control", NC).sendFile("mirae-insights.html"));

  // [A] Scraper APIs.
  await app.register(enrichRoutes);
  await app.register(progressRoutes);
  await app.register(resultRoutes);

  // [B] Call dashboard APIs.
  await app.register(leadsRoutes);
  await app.register(outcomeRoutes);
  await app.register(statsRoutes);
  await app.register(capturesRoutes);
  await app.register(pipelineRoutes);
  await app.register(salesLeadRoutes);

  // [D] Visitation Log APIs.
  await app.register(visitsRoutes);
  await app.register(salespeopleRoutes);
  await app.register(listsRoutes);
  await app.register(insightsRoutes);
  await app.register(accountsRoutes);
  await app.register(escalationsRoutes);

  // [M] Mirae Visitation Log APIs.
  await app.register(miraeRoutes);

  await bootDatabase(app);
  startCadenceEngine();

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await closeDatabase();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

void main();
