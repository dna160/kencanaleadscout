/**
 * Outbound connection defaults, applied once before anything connects.
 *
 * Node ≥ 20 races a host's addresses ("happy eyeballs") and gives each one only
 * 250 ms to complete the TCP handshake before moving on. Selaras (Hostinger)
 * answers Railway's Singapore region in ~250–300 ms, so whenever the route was
 * a little slow every request died as `AggregateError (ETIMEDOUT)`: the IPv4
 * attempt was abandoned before its SYN-ACK arrived (Railway's flow log shows
 * the reply dropped as NO_SOCKET at 275 ms), and the IPv6 attempt failed
 * after it. That took the ERP sync down from 17 to 23 Nov and again from
 * 24 Nov 2026.
 *
 * NET_CONNECT_ATTEMPT_MS (default 5000) is how long each address gets; the
 * request's own timeout still bounds the whole call.
 */
import net from "node:net";

export const DEFAULT_CONNECT_ATTEMPT_MS = 5_000;

export function applyNetDefaults(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NET_CONNECT_ATTEMPT_MS);
  const ms = Number.isInteger(raw) && raw >= 250 && raw <= 60_000 ? raw : DEFAULT_CONNECT_ATTEMPT_MS;
  net.setDefaultAutoSelectFamilyAttemptTimeout(ms);
  return ms;
}

applyNetDefaults();
