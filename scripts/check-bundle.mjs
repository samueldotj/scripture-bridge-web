#!/usr/bin/env node
/**
 * Asserts that nothing privileged reached the browser (WEB R-SEC-WEB-2).
 *
 * This is the check whose failure is most expensive and least visible: a
 * service key in a client chunk is a full compromise of every project's data
 * (DB R-RLS-3), it produces no error, and nobody notices by using the console.
 * It was performed by hand on the first cut; a habit is not a control.
 *
 *   npm run check-bundle          (after a build)
 *
 * Two kinds of finding:
 *
 *   1. A configured secret's VALUE appearing in the client output. Checked only
 *      for values actually present in the environment — in CI with placeholder
 *      values this still works, because the placeholders are what the build
 *      would have inlined.
 *   2. A shape that should never be there regardless of environment: a JWT, a
 *      Postgres URL, or a server-only module's fingerprint.
 *
 * The second kind is what catches the case the first cannot: a build on a
 * machine whose real key was never in this process's environment.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const OK = '  [32mok[0m   ';
const BAD = '  [31mFAIL[0m ';

let failures = 0;

function pass(msg) { console.log(OK + msg); }
function fail(msg, detail) {
  failures += 1;
  console.log(BAD + msg);
  if (detail) console.log('       ' + detail);
}

// The client-visible output. Server chunks legitimately contain keys and are
// deliberately not scanned: .next/server never reaches a browser.
const CLIENT_DIRS = ['.next/static'];

if (!existsSync('.next')) {
  console.error('\nNo .next directory. Run `npm run build` first.\n');
  process.exit(1);
}

function walk(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

const files = CLIENT_DIRS.flatMap((d) => walk(d)).filter((f) =>
  /\.(js|mjs|css|map|json|txt|html)$/.test(f),
);

if (files.length === 0) {
  fail('no client assets found under .next/static', 'Did the build succeed?');
  process.exit(1);
}

console.log(`\nScanning ${files.length} client asset(s)\n`);

const contents = files.map((path) => ({ path, text: readFileSync(path, 'utf8') }));

// ------------------------------------------------------- configured values

/**
 * Values that must never be inlined. `CONSOLE_OPERATORS` is deliberately absent:
 * an operator's address is not a credential, and it would produce a false
 * positive on any page that legitimately shows the signed-in operator.
 */
const SECRET_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'SUPABASE_ANON_KEY',
  'DATABASE_URL',
  'CONSOLE_SESSION_SECRET',
];

let checkedAny = false;
for (const name of SECRET_VARS) {
  const value = process.env[name];
  // A short value would match half the alphabet; below this length a literal
  // scan is noise rather than signal, and the shape rules below cover it.
  if (!value || value.trim().length < 12) continue;
  checkedAny = true;

  const hits = contents.filter((f) => f.text.includes(value.trim()));
  if (hits.length === 0) pass(`${name} value does not appear in the client bundle`);
  else {
    fail(
      `${name} VALUE IS IN THE CLIENT BUNDLE`,
      hits.map((h) => h.path).join(', '),
    );
  }
}

if (!checkedAny) {
  console.log(
    '  [33mnote[0m no secrets in this environment to match literally; ' +
      'shape rules below still apply',
  );
}

// ------------------------------------------------------------- shape rules

/**
 * Patterns that are wrong regardless of what this machine's environment held.
 *
 * `pgPool` and `node:crypto`-style fingerprints catch a server module dragged
 * into a client chunk by a stray import — the failure mode `server-only` is
 * meant to prevent, asserted here in case a future refactor drops that import.
 */
const FORBIDDEN = [
  {
    name: 'a JWT (Supabase keys are JWTs)',
    // Three base64url segments; the header of a Supabase key decodes from eyJ.
    re: /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\./,
  },
  {
    name: 'a Postgres connection string',
    re: /postgres(?:ql)?:\/\/[^\s"'`]*:[^\s"'`]*@/,
  },
  {
    name: 'a new-style Supabase secret key',
    re: /\bsb_secret_[A-Za-z0-9]{8,}/,
  },
  {
    name: 'the pg driver (a server module in client output)',
    re: /\bpg-connection-string\b|\bPoolClient\b|\bnew Pool\(/,
  },
];

for (const rule of FORBIDDEN) {
  const hits = [];
  for (const f of contents) {
    const m = rule.re.exec(f.text);
    if (m) hits.push(`${f.path} (…${m[0].slice(0, 24)}…)`);
  }
  if (hits.length === 0) pass(`clean: ${rule.name}`);
  else fail(`FOUND ${rule.name}`, hits.join('\n       '));
}

// ---------------------------------------------------------------- verdict

console.log('');
if (failures > 0) {
  console.log(`[31m${failures} check(s) failed.[0m Do not deploy this build.\n`);
  process.exit(1);
}
console.log('[32mClient bundle is clean.[0m\n');
