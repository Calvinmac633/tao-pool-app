import { createClient, type Client } from "@libsql/client";
import { mkdirSync } from "node:fs";
import path from "node:path";

// Local SQLite file by default. Point TRACKER_DB_URL at a hosted libsql/Turso
// database later (plus TRACKER_DB_AUTH_TOKEN) to deploy without code changes.
const DEFAULT_DB_URL = "file:data/tracker.db";

const SCHEMA = [
  // One row per position ever seen for a wallet. closed_at is set when a
  // snapshot run no longer finds the position open.
  `CREATE TABLE IF NOT EXISTS positions (
    position_id   TEXT PRIMARY KEY,
    wallet        TEXT NOT NULL,
    pool_id       TEXT NOT NULL,
    pool_name     TEXT NOT NULL,
    symbol_a      TEXT NOT NULL,
    symbol_b      TEXT NOT NULL,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL,
    closed_at     TEXT
  )`,
  // One row per snapshot attempt for a wallet.
  `CREATE TABLE IF NOT EXISTS snapshot_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet          TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    finished_at     TEXT,
    status          TEXT NOT NULL,
    positions_found INTEGER,
    error           TEXT
  )`,
  // One row per open position per successful run. Token amounts and the
  // price at the time are stored so USD figures can be recomputed later
  // rather than drifting with today's price.
  `CREATE TABLE IF NOT EXISTS snapshots (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id        INTEGER NOT NULL REFERENCES snapshot_runs(id),
    taken_at      TEXT NOT NULL,
    wallet        TEXT NOT NULL,
    position_id   TEXT NOT NULL,
    pool_id       TEXT NOT NULL,
    price_a       REAL NOT NULL,
    amount_a      REAL NOT NULL,
    amount_b      REAL NOT NULL,
    usd_value     REAL NOT NULL,
    fee_amount_a  REAL NOT NULL,
    fee_amount_b  REAL NOT NULL,
    fee_usd       REAL NOT NULL,
    reward_usd    REAL NOT NULL,
    rewards_json  TEXT NOT NULL,
    raw_json      TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS snapshots_position_time ON snapshots (position_id, taken_at)`,
  `CREATE INDEX IF NOT EXISTS snapshots_wallet_time ON snapshots (wallet, taken_at)`,
];

// Cached on globalThis so dev-mode hot reloads reuse one connection.
const globalForDb = globalThis as unknown as { __trackerDb?: Promise<Client> };

export function getDb(): Promise<Client> {
  if (!globalForDb.__trackerDb) {
    globalForDb.__trackerDb = openDb();
  }
  return globalForDb.__trackerDb;
}

async function openDb(): Promise<Client> {
  const url = process.env.TRACKER_DB_URL ?? DEFAULT_DB_URL;
  if (url.startsWith("file:")) {
    mkdirSync(path.dirname(path.resolve(url.slice("file:".length))), { recursive: true });
  }
  const client = createClient({ url, authToken: process.env.TRACKER_DB_AUTH_TOKEN });
  for (const statement of SCHEMA) {
    await client.execute(statement);
  }
  return client;
}
