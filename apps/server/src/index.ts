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
  app.get("/", (_req, reply) => reply.sendFile("index.html"));
  app.get("/scraper", (_req, reply) => reply.sendFile("scraper.html"));
  app.get("/calls", (_req, reply) => reply.sendFile("calls.html"));
  app.get("/champion", (_req, reply) => reply.sendFile("champion.html"));

  // [A] Scraper APIs.
  await app.register(enrichRoutes);
  await app.register(progressRoutes);
  await app.register(resultRoutes);

  // [B] Call dashboard APIs.
  await app.register(leadsRoutes);
  await app.register(outcomeRoutes);
  await app.register(statsRoutes);

  await bootDatabase(app);

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
