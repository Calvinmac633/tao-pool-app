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
  // Every wallet transaction that moved a strategy token (lib/ledger.ts).
  `CREATE TABLE IF NOT EXISTS wallet_txs (
    signature        TEXT PRIMARY KEY,
    wallet           TEXT NOT NULL,
    block_time       TEXT NOT NULL,
    delta_a          REAL NOT NULL,
    delta_b          REAL NOT NULL,
    others_json      TEXT NOT NULL,
    account_keys_json TEXT,
    kind             TEXT NOT NULL,
    position_id      TEXT,
    note             TEXT,
    price_a          REAL,
    swap_cost_b      REAL
  )`,
  `CREATE INDEX IF NOT EXISTS wallet_txs_wallet_time ON wallet_txs (wallet, block_time)`,
  // Where the ledger sync left off.
  `CREATE TABLE IF NOT EXISTS ledger_state (
    wallet           TEXT PRIMARY KEY,
    newest_signature TEXT,
    oldest_signature TEXT,
    backfill_done    INTEGER NOT NULL DEFAULT 0,
    updated_at       TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS snapshots_position_time ON snapshots (position_id, taken_at)`,
  `CREATE INDEX IF NOT EXISTS snapshots_wallet_time ON snapshots (wallet, taken_at)`,
];

// Columns added after the first release. Applied with ALTER TABLE when
// missing so existing databases upgrade in place.
const ADDED_COLUMNS: [table: string, column: string, type: string][] = [
  ["positions", "decimals_a", "INTEGER"],
  ["positions", "decimals_b", "INTEGER"],
  ["positions", "mint_a", "TEXT"],
  ["positions", "mint_b", "TEXT"],
  // Filled from the position's open transaction (lib/position-history.ts).
  ["positions", "opened_at", "TEXT"],
  ["positions", "open_signature", "TEXT"],
  ["positions", "entry_amount_a", "REAL"],
  ["positions", "entry_amount_b", "REAL"],
  ["positions", "history_attempts", "INTEGER"],
  ["positions", "deposits_json", "TEXT"], // DepositTx[] from lib/position-history.ts
  // Loose (not in a position) strategy-token balances at each run, for the ledger reconciliation.
  ["snapshot_runs", "free_amount_a", "REAL"],
  ["snapshot_runs", "free_amount_b", "REAL"],
  ["snapshot_runs", "positions_failed", "INTEGER"], // runs with failed fetches are skipped by the reconciliation
  ["snapshots", "tick_lower", "INTEGER"],
  ["snapshots", "tick_upper", "INTEGER"],
  ["snapshots", "liquidity", "TEXT"],
  ["snapshots", "price_lower", "REAL"],
  ["snapshots", "price_upper", "REAL"],
  ["snapshots", "in_range", "INTEGER"],
];

// Cached on globalThis so dev-mode hot reloads reuse one connection. The key
// carries a version so a schema change re-runs migrations after a reload.
const SCHEMA_VERSION = 6;
const globalForDb = globalThis as unknown as Record<string, Promise<Client> | undefined>;
const DB_KEY = `__trackerDb_v${SCHEMA_VERSION}`;

export function getDb(): Promise<Client> {
  if (!globalForDb[DB_KEY]) {
    globalForDb[DB_KEY] = openDb();
  }
  return globalForDb[DB_KEY]!;
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
  for (const [table, column, type] of ADDED_COLUMNS) {
    const info = await client.execute(`PRAGMA table_info(${table})`);
    if (!info.rows.some((r) => r.name === column)) {
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    }
  }
  return client;
}
