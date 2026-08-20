import 'server-only';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from './env';
import { toConsoleError } from './errors';

/**
 * The console's connection to Postgres.
 *
 * WHY A DIRECT CONNECTION RATHER THAN PostgREST + THE SERVICE KEY
 *
 * `scripture-bridge-db` grants the console RPCs to `service_role`, which
 * implies they would be called over `/rest/v1/rpc/...`. Two things stop that
 * from working today:
 *
 *   1. `service_role` is never granted USAGE on schema `api`. Supabase's stock
 *      role setup grants that for `public` only, and migration 0001 grants
 *      `api` to `authenticated` alone. Every console RPC — and
 *      `api.anonymise_profile` — is therefore unreachable over HTTP as
 *      service_role, and nothing in that repo exercises the path: pgTAP runs
 *      as `postgres` and `provision.sh` uses psql. See docs/architecture.md.
 *   2. Three of the console's read surfaces are not exposed at all. Project
 *      members, the audit log, and the book canon live in `app` and `ref`,
 *      which PostgREST cannot reach by design (DB R-SCHEMA-2).
 *
 * `scripts/provision.sh` — the roadmap's designated console stand-in — already
 * resolves this the same way: psql for data, the GoTrue admin API for accounts.
 * This console does exactly that, so it needs no change to the database repo to
 * run, and it calls the same `api.*` functions provision.sh calls, so the rules
 * still have one implementation (the whole point of migration 0015).
 *
 * The connecting role bypasses RLS. That is correct here and nowhere else: a
 * coordinator provisioning a cohort is not a member of the projects they
 * administer, and RLS would show them nothing.
 */

declare global {
  // eslint-disable-next-line no-var
  var __sbConsolePool: Pool | undefined;
}

function createPool(): Pool {
  const { databaseUrl } = config();

  // A hosted Supabase URL carries `sslmode=require`, which the driver honours.
  // A URL with no sslmode pointing anywhere but loopback is almost certainly a
  // mistake, so it gets TLS rather than a silent plaintext connection.
  const host = (() => {
    try {
      return new URL(databaseUrl).hostname;
    } catch {
      return '';
    }
  })();
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  const declaresSsl = /[?&]sslmode=/.test(databaseUrl);

  return new Pool({
    connectionString: databaseUrl,
    ssl: declaresSsl || isLoopback ? undefined : { rejectUnauthorized: true },
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // Long enough for `create_project`, which materialises every verse of every
    // book it is given — 1,071 rows for Matthew, ~31,000 for a whole Bible.
    statement_timeout: 120_000,
    application_name: 'scripture-bridge-console',
  });
}

function pool(): Pool {
  // Next's dev server re-evaluates modules on every edit. Without this the
  // pools accumulate until Postgres refuses new connections.
  if (!globalThis.__sbConsolePool) {
    globalThis.__sbConsolePool = createPool();
    globalThis.__sbConsolePool.on('error', (err) => {
      console.error('[console] idle client error', err.message);
    });
  }
  return globalThis.__sbConsolePool;
}

export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  try {
    const result = await pool().query<T>(text, params as unknown[]);
    return result.rows;
  } catch (err) {
    throw toConsoleError(err);
  }
}

export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Calls one of the `api.*` console functions and returns its jsonb result.
 *
 * Every write the console performs goes through here. None of them are
 * reimplemented in SQL in this repository: validation, the change-log entry
 * that makes an assignment reach a device, and the audit row all live in the
 * function (DB migration 0015), and duplicating any of it is how the console
 * and provision.sh would drift apart on a rule that decides whether a
 * translator can see their work.
 */
export async function callRpc<T = unknown>(
  fn: string,
  args: readonly unknown[],
): Promise<T> {
  const placeholders = args.map((_, i) => `$${i + 1}`).join(', ');
  const rows = await query<{ result: T }>(
    `select ${fn}(${placeholders}) as result`,
    args,
  );
  const row = rows[0];
  if (!row) {
    throw toConsoleError(new Error(`${fn} returned no row`));
  }
  return row.result;
}

/** Runs several statements in one transaction. Used where a partial result would mislead. */
export async function transaction<T>(
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool().connect();
  try {
    await client.query('begin');
    const out = await fn(client);
    await client.query('commit');
    return out;
  } catch (err) {
    await client.query('rollback').catch(() => undefined);
    throw toConsoleError(err);
  } finally {
    client.release();
  }
}
