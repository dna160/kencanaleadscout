/**
 * In-memory job store for the scraper (microPRD §4). A single-process Map is
 * sufficient: Part A needs no persistence and Railway runs one instance.
 *
 * Jobs are swept after a TTL so long-running deployments don't leak buffers.
 */
import { randomUUID } from "node:crypto";

export type JobStatus = "running" | "done" | "error";

export interface JobState {
  id: string;
  status: JobStatus;
  total: number;
  done: number;
  found: number;
  error: string;
  /** Original upload filename, used to name the download. */
  filename: string;
  /** Enriched workbook, present once status === "done". */
  result?: Buffer;
  createdAt: number;
}

const TTL_MS = 60 * 60 * 1000; // 1 hour
const jobs = new Map<string, JobState>();

function sweep(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > TTL_MS) jobs.delete(id);
  }
}

export function createJob(total: number, filename: string): JobState {
  sweep();
  const job: JobState = {
    id: randomUUID(),
    status: "running",
    total,
    done: 0,
    found: 0,
    error: "",
    filename,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): JobState | undefined {
  return jobs.get(id);
}

export function updateProgress(id: string, done: number, found: number): void {
  const job = jobs.get(id);
  if (job) {
    job.done = done;
    job.found = found;
  }
}

export function finishJob(id: string, result: Buffer): void {
  const job = jobs.get(id);
  if (job) {
    job.status = "done";
    job.result = result;
    job.done = job.total;
  }
}

export function failJob(id: string, error: string): void {
  const job = jobs.get(id);
  if (job) {
    job.status = "error";
    job.error = error;
  }
}
