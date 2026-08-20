#!/usr/bin/env node
/**
 * Preflight for the console's dependencies.
 *
 * The console fails in exactly three ways, and they look the same from the
 * browser: a value missing from the environment, a database it cannot reach,
 * and a database whose migrations predate the console API. This checks all
 * three before an operator finds them, and additionally asserts the two auth
 * settings whose misconfiguration is invisible until it locks someone out.
 *
 *   npm run check-stack
 *
 * Reads .env.local, then .env, then the process environment. Nothing is
 * written; the service key is used but never printed.
 */

import { readFileSync, existsSync } from 'node:fs';
import { Client } from 'pg';

const OK = '  [32mok[0m   ';
const BAD = '  [31mFAIL[0m ';
const WARN = '  [33mwarn[0m ';

let failures = 0;
let warnings = 0;

function pass(msg) { console.log(OK + msg); }
function fail(msg, hint) {
  failures += 1;
  console.log(BAD + msg);
  if (hint) console.log('       ' + hint);
}
function warn(msg, hint) {
  warnings += 1;
  console.log(WARN + msg);
  if (hint) console.log('       ' + hint);
}

// --------------------------------------------------------------- environment

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile('.env.local');
loadEnvFile('.env');

console.log('\nConfiguration');

const REQUIRED = [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'CONSOLE_OPERATORS',
  'CONSOLE_SESSION_SECRET',
];

for (const name of REQUIRED) {
  if (process.env[name] && process.env[name].trim() !== '') pass(`${name} is set`);
  else fail(`${name} is not set`, 'Copy .env.example to .env.local and fill it in.');
}

if (process.env.CONSOLE_SESSION_SECRET && process.env.CONSOLE_SESSION_SECRET.length < 32) {
  fail(
    'CONSOLE_SESSION_SECRET is shorter than 32 characters',
    'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  );
}

if (failures > 0) {
  console.log('\nStopping: fix the configuration first.\n');
  process.exit(1);
}

const apiUrl = process.env.SUPABASE_URL.replace(/\/+$/, '');

// ------------------------------------------------------------------ database

console.log('\nDatabase');

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: /[?&]sslmode=/.test(process.env.DATABASE_URL) ||
       /@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL)
    ? undefined
    : { rejectUnauthorized: true },
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
});

try {
  await client.connect();
  pass('connected');
} catch (err) {
  fail(`cannot connect: ${err.message}`, 'Is the Supabase stack running, and is DATABASE_URL right?');
  console.log('\nStopping: the database is unreachable.\n');
  process.exit(1);
}

async function scalar(sql, params = []) {
  const { rows } = await client.query(sql, params);
  return rows[0] ? Object.values(rows[0])[0] : null;
}

try {
  // DB R-PLAT-DB-1: three requirements depend on Postgres 15 or newer.
  const version = Number(await scalar('show server_version_num'));
  if (version >= 150000) pass(`Postgres ${(version / 10000).toFixed(0)}`);
  else fail(`Postgres is older than 15 (server_version_num ${version})`);

  for (const schema of ['app', 'api', 'ref']) {
    const found = await scalar(
      'select 1 from information_schema.schemata where schema_name = $1',
      [schema],
    );
    if (found) pass(`schema ${schema} exists`);
    else fail(`schema ${schema} is missing`, 'Run the migrations in scripture-bridge-db.');
  }

  // The functions the console calls. A missing one means the database predates
  // migration 0015 and the console will fail at the point of use.
  const CONSOLE_FUNCTIONS = [
    'create_project',
    'add_project_member',
    'assign_chapter',
    'reopen_chapter',
    'rearm_password_change',
  ];
  for (const fn of CONSOLE_FUNCTIONS) {
    const found = await scalar(
      `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'api' and p.proname = $1`,
      [fn],
    );
    if (found) pass(`api.${fn} exists`);
    else fail(`api.${fn} is missing`, 'The console API migration (0015) has not been applied.');
  }

  const auditFn = await scalar(
    `select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'app' and p.proname = 'console_audit'`,
  );
  if (auditFn) pass('app.console_audit exists');
  else fail('app.console_audit is missing', 'Account creation cannot write its audit entry.');

  // Added by migration 0015. Without it the audit trail records that a console
  // acted but not which coordinator (DB R-AUTH-DB-12).
  const actorLabel = await scalar(
    `select 1 from information_schema.columns
      where table_schema = 'app' and table_name = 'audit_log' and column_name = 'actor_label'`,
  );
  if (actorLabel) pass('app.audit_log.actor_label exists');
  else fail('app.audit_log.actor_label is missing', 'Operator identity cannot be recorded.');

  // A scheme with no versification rows cannot materialise a book, so no
  // project can be created against it (DB R-DATA-2).
  const schemes = await client.query(
    `select s.code,
            exists (select 1 from ref.versification v where v.scheme_code = s.code) as seeded
       from ref.versification_scheme s order by s.code`,
  );
  const seeded = schemes.rows.filter((r) => r.seeded).map((r) => r.code);
  if (seeded.length > 0) pass(`versification seeded for: ${seeded.join(', ')}`);
  else fail('no versification scheme has any data', 'No project can be created.');

  const canon = Number(await scalar('select count(*) from ref.book_canon'));
  if (canon > 0) pass(`ref.book_canon has ${canon} books`);
  else fail('ref.book_canon is empty');

  // Informational: the console uses a direct connection, so this does not block
  // it. It does block the PostgREST path the DB repo's grants imply — see
  // docs/architecture.md.
  const serviceUsage = await scalar(
    `select has_schema_privilege('service_role', 'api', 'usage')
      where exists (select 1 from pg_roles where rolname = 'service_role')`,
  );
  if (serviceUsage === false) {
    warn(
      'service_role has no USAGE on schema api',
      'Expected on a stock stack. The console does not need it; a PostgREST console would.',
    );
  } else if (serviceUsage === true) {
    pass('service_role has USAGE on schema api');
  }
} finally {
  await client.end();
}

// ---------------------------------------------------------------------- auth

console.log('\nAuth service');

async function authGet(path, key) {
  const res = await fetch(`${apiUrl}${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(15_000),
  });
  return res;
}

try {
  const settings = await authGet('/auth/v1/settings', process.env.SUPABASE_ANON_KEY);
  if (!settings.ok) {
    fail(`GET /auth/v1/settings returned ${settings.status}`, 'Is SUPABASE_ANON_KEY correct?');
  } else {
    pass('reachable, anon key accepted');
    const body = await settings.json();

    // DB R-AUTH-DB-1. The app relies on this and does not compensate for it.
    if (body.disable_signup === true) pass('self-registration is disabled');
    else fail('self-registration is ENABLED', 'Set [auth].enable_signup = false (DB R-AUTH-DB-1).');

    // R-AUTH-DB-2/3: email/password only, and it must stay enabled or every
    // admin-provisioned account fails to sign in.
    if (body.external && body.external.email === true) pass('email provider is enabled');
    else if (body.external) {
      fail(
        'the email provider is disabled',
        'Every provisioned account would fail sign-in with "Email logins are disabled".',
      );
    }
  }

  const admin = await authGet(
    '/auth/v1/admin/users?page=1&per_page=1',
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  );
  if (admin.ok) pass('admin API accepts the service key');
  else {
    fail(
      `admin API returned ${admin.status}`,
      'Account creation and password reset will not work. Check SUPABASE_SERVICE_ROLE_KEY.',
    );
  }
} catch (err) {
  fail(`cannot reach ${apiUrl}: ${err.message}`);
}

// -------------------------------------------------------------------- verdict

console.log('');
if (failures > 0) {
  console.log(`[31m${failures} check(s) failed[0m${warnings ? `, ${warnings} warning(s)` : ''}.\n`);
  process.exit(1);
}
console.log(
  `[32mAll checks passed[0m${warnings ? `, with ${warnings} warning(s)` : ''}.\n`,
);
