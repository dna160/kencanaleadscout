/**
 * Kabar Pesanan WP-3 — wiring for the event deriver.
 *
 *  - Subscribes to the order lane: every batch (poll or webhook) is derived
 *    immediately, so an ERP movement becomes an event within the same tick.
 *  - A timer (EVENTS_SWEEP_MS) runs the catch-up sweep and, every
 *    EVENTS_LATE_SWEEP_MINUTES, the so.late check.
 *
 * Needs only the database: with the lane off, the sweep still derives from
 * whatever the stock sync writes to erp_so_header.
 */
import { config, hasDatabase } from "../config.js";
import { getSql } from "../db/client.js";
import { onOrderRows } from "../erp/orderSync.js";
import { redactSecrets } from "../erp/selarasClient.js";
import { deriveForTouched, lateSweepDue, sweepEvents, sweepLate } from "./store.js";

let unsubscribe: (() => void) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<unknown> | null = null;

/** One sweep pass: catch-up, then so.late when due. Never throws. */
export async function runEventSweepOnce(): Promise<{ inserted: number } | null> {
  const db = getSql();
  if (!db) return null;
  try {
    const s = await sweepEvents(db);
    let inserted = s.inserted.length;
    if (await lateSweepDue(db, config.events.lateSweepMinutes)) inserted += (await sweepLate(db)).length;
    if (inserted) console.log(`[events] sweep recorded ${inserted} new event(s).`);
    return { inserted };
  } catch (err) {
    console.error(`[events] sweep failed: ${redactSecrets(err)}`);
    return null;
  }
}

export function startEventDeriver(): void {
  if (!hasDatabase || unsubscribe) return;
  unsubscribe = onOrderRows(async (touched, db, origin) => {
    const inserted = await deriveForTouched(db, touched, origin);
    if (inserted.length) {
      const byType = inserted.reduce<Record<string, number>>((a, e) => ((a[e.event_type] = (a[e.event_type] ?? 0) + 1), a), {});
      console.log(`[events] ${origin}: ${JSON.stringify(byType)}`);
    }
  });
  if (config.events.sweepMs > 0) {
    timer = setInterval(() => {
      if (inFlight) return;
      inFlight = runEventSweepOnce().finally(() => {
        inFlight = null;
      });
    }, config.events.sweepMs);
    timer.unref?.();
  }
  console.log(`[events] deriver started (sweep every ${config.events.sweepMs} ms).`);
}

export async function stopEventDeriver(): Promise<void> {
  unsubscribe?.();
  unsubscribe = null;
  if (timer) clearInterval(timer);
  timer = null;
  if (inFlight) await inFlight.catch(() => undefined);
}
