#!/usr/bin/env node
/**
 * Reset a console operator's own password (WEB §11.4).
 *
 *   npm run reset-operator
 *   npm run reset-operator -- coordinator@example.org
 *   npm run reset-operator -- --dry-run
 *
 * `--dry-run` does everything except change anything: it resolves the account,
 * prompts for the password, and stops. The real run is the one nobody wants to
 * rehearse on, so it is worth being able to.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE CONSOLE
 *
 * The console resets other people's passwords, and doing so requires being
 * signed in. An operator who cannot sign in is therefore locked out of the tool
 * that fixes exactly this problem — a bootstrap gap with no way out from
 * inside. This is the way out, and it is the only console operation that
 * deliberately lives outside the console.
 *
 * IT WILL NOT RESET A TRANSLATOR. Only addresses listed in CONSOLE_OPERATORS
 * are accepted. A translator's reset belongs in the console because two things
 * must happen together: the password is set AND `api.rearm_password_change`
 * re-arms the forced change and re-fingerprints the new hash (DB R-AUTH-DB-7).
 * A script that did only the first would leave a translator able to sign in
 * with a password a coordinator knows and no forced change pending — precisely
 * what that flag exists to prevent.
 *
 * Operators are not re-armed, deliberately: `must_change_password` does not
 * gate console access, because the console never reads project data with an
 * operator's JWT.
 */

import { Client } from 'pg';
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { userInfo } from 'node:os';
import { sslConfig, explainTlsFailure } from '../src/lib/pg-ssl.ts';

const OK = '  [32mok[0m   ';
const BAD = '  [31mFAIL[0m ';
const DIM = '[2m';
const RESET = '[0m';

/** Matches the console's own floor for a password it hands to a person (R-POLICY-WEB-3). */
const MIN_PASSWORD_LENGTH = 12;

function die(message, hint) {
  console.error(`\n${BAD}${message}`);
  if (hint) console.error(`       ${hint}`);
  console.error('');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Configuration — the same variables the console reads
// ---------------------------------------------------------------------------

const env = { ...process.env };
for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (env[key] === undefined || env[key] === '') env[key] = value;
  }
}

for (const name of [
  'DATABASE_URL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'CONSOLE_OPERATORS',
]) {
  if (!env[name] || env[name].trim() === '') {
    die(`${name} is not set.`, 'This script reads the same configuration as the console.');
  }
}

const apiUrl = env.SUPABASE_URL.replace(/\/+$/, '');
const operators = env.CONSOLE_OPERATORS.split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

// ---------------------------------------------------------------------------
// Who
// ---------------------------------------------------------------------------

const dryRun = process.argv.includes('--dry-run');
const requested = process.argv.slice(2).find((a) => !a.startsWith('-'));
const email = (requested ?? operators[0] ?? '').trim().toLowerCase();

if (!email) die('No address given and CONSOLE_OPERATORS is empty.');

// The refusal that keeps this script from becoming a second, unaudited,
// non-re-arming implementation of the console's translator reset.
if (!operators.includes(email)) {
  die(
    `${email} is not listed in CONSOLE_OPERATORS.`,
    'This script resets console operators only. Reset a translator through the console,\n' +
      '       which also re-arms their forced password change — a script that skipped that\n' +
      '       would leave them signed in on a password you know, with no change pending.',
  );
}

// ---------------------------------------------------------------------------
// Password
// ---------------------------------------------------------------------------

/**
 * Reads a line without echoing it.
 *
 * The password is never accepted as an argument, deliberately: an argument
 * lands in shell history and in the process list, where it outlives the reset.
 */
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    rl._writeToOutput = (chunk) => {
      if (!muted) rl.output.write(chunk);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

if (!process.stdin.isTTY) {
  die(
    'This script needs a terminal so it can prompt for the password without echoing it.',
    'It will not take a password as an argument: that would put it in shell history.',
  );
}

// ---------------------------------------------------------------------------

const db = new Client({
  connectionString: env.DATABASE_URL,
  ssl: sslConfig(env.DATABASE_URL, env),
  connectionTimeoutMillis: 10_000,
  statement_timeout: 15_000,
});

try {
  await db.connect();
} catch (err) {
  const tls = explainTlsFailure(err.message);
  console.error(`\n${BAD}cannot connect to the database: ${err.message}\n`);
  if (tls) console.error(tls + '\n');
  process.exit(1);
}

try {
  const { rows } = await db.query(
    `select u.id as auth_user_id, u.email, p.id as profile_id,
            u.last_sign_in_at, u.banned_until
       from auth.users u
       left join app.profile p on p.auth_user_id = u.id
      where lower(u.email) = $1`,
    [email],
  );

  const account = rows[0];
  if (!account) {
    die(
      `No account exists for ${email}.`,
      'Create it first — Supabase dashboard, Authentication -> Users -> Add user,\n' +
        '       with Auto Confirm User ticked — then add the address to CONSOLE_OPERATORS.',
    );
  }

  console.log(
    `\n${dryRun ? 'DRY RUN — nothing will be changed.\n' : ''}` +
      `Resetting the console password for ${DIM}${account.email}${RESET}`,
  );
  if (account.banned_until) {
    console.log(`  ${DIM}note: this account is banned until ${account.banned_until}${RESET}`);
  }
  console.log(
    `  ${DIM}last sign-in: ${account.last_sign_in_at ?? 'never'}${RESET}\n`,
  );

  const first = await askHidden('New password: ');
  if (first.length < MIN_PASSWORD_LENGTH) {
    die(`The password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  const second = await askHidden('Repeat it:    ');
  // A mistyped password would lock the operator out harder than they already
  // are, and this script is what they would have used to recover.
  if (first !== second) die('The two entries do not match. Nothing was changed.');

  if (dryRun) {
    console.log(`${OK}the two entries match`);
    console.log(
      `${OK}would PUT /auth/v1/admin/users/${account.auth_user_id} and write an audit row`,
    );
    console.log(`\n${DIM}Dry run: nothing was changed.${RESET}\n`);
    process.exit(0);
  }

  const res = await fetch(`${apiUrl}/auth/v1/admin/users/${account.auth_user_id}`, {
    method: 'PUT',
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ password: first }),
    signal: AbortSignal.timeout(20_000),
  });

  if (!res.ok) {
    // The body can echo the submitted password on some GoTrue paths, so only a
    // short message is surfaced (DB R-ERR-4).
    let detail = '';
    try {
      const body = await res.json();
      const candidate = body?.msg ?? body?.message ?? body?.error_description;
      if (typeof candidate === 'string') detail = candidate;
    } catch {
      /* a non-JSON body tells us nothing worth printing */
    }
    die(`The auth service refused the change (HTTP ${res.status}).`, detail);
  }

  console.log(`${OK}password changed`);

  // DB R-AUTH-DB-12: every service-key operation is recorded. This one happens
  // outside the console, so it labels itself accordingly — the same convention
  // provision.sh uses, so an audit reader can tell the three apart.
  if (account.profile_id) {
    const label = `${userInfo().username ?? 'unknown'}@reset-operator`;
    await db.query(
      `select app.console_audit($1, $2, $3::uuid, $4, null::jsonb, $5::jsonb)`,
      [
        'operator.password_reset',
        'profile',
        account.profile_id,
        label,
        JSON.stringify({ email: account.email }),
      ],
    );
    console.log(`${OK}recorded in the audit log as ${label}`);
  } else {
    console.log(
      `  ${DIM}note: no profile row for this account, so nothing was written to the audit log${RESET}`,
    );
  }

  console.log(
    `\n${DIM}must_change_password was NOT re-armed: it does not gate console access,\n` +
      `because the console never reads project data with an operator's JWT.${RESET}`,
  );
  console.log('\nSign in at /login with the new password.\n');
} finally {
  await db.end();
}
