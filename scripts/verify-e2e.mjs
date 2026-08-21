#!/usr/bin/env node
/**
 * The M4 verification sequence (WEB R-TEST-WEB-5, roadmap §4.2).
 *
 * Drives every operation the console performs, against a live stack, through
 * the same two interfaces the console uses: `api.*` functions over a direct
 * connection, and the GoTrue admin API. It asserts the outcomes rather than the
 * return values — what matters is not that `assign_chapter` returned JSON, but
 * that a change-log entry exists afterwards, because that entry is the only way
 * the assignment reaches a translator's device (DB R-SYNC-1).
 *
 * This is also the first exercise of DB migration 0015's functions in the shape
 * they were designed for. Until now they had been called only by pgTAP as
 * `postgres` and by `provision.sh` through psql.
 *
 *   npm run verify-e2e -- --i-know-this-writes
 *
 * IT WRITES REAL DATA and does not clean up: project rows cascade nowhere
 * (ON DELETE RESTRICT, DB R-DATA-4), so removing a project means deleting
 * thousands of rows in dependency order, which is a runbook and not a test
 * fixture. Intended for a disposable stack — CI after `supabase db reset`, or a
 * local `supabase start`. It refuses to run anywhere else without the flag.
 *
 * Set CONSOLE_URL to additionally smoke-test a running console.
 */

import { Client } from 'pg';
import { randomBytes, createHmac } from 'node:crypto';
import { buildUsfm } from '../src/lib/usfm.ts';

const OK = '  [32mok[0m   ';
const BAD = '  [31mFAIL[0m ';
const DIM = '[2m';
const RESET = '[0m';

let failures = 0;

function pass(msg) { console.log(OK + msg); }
function fail(msg, detail) {
  failures += 1;
  console.log(BAD + msg);
  if (detail) console.log('       ' + String(detail).split('\n')[0]);
}
function check(condition, msg, detail) {
  if (condition) pass(msg);
  else fail(msg, detail);
  return condition;
}
function section(name) { console.log(`\n${name}`); }

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

if (!process.argv.includes('--i-know-this-writes') && process.env.CI !== 'true') {
  console.error(
    '\nThis script creates accounts, projects, and assignments, and does not\n' +
      'clean up. Run it against a disposable stack:\n\n' +
      '  npm run verify-e2e -- --i-know-this-writes\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Configuration — same variables the console reads
// ---------------------------------------------------------------------------

import { readFileSync, existsSync } from 'node:fs';

for (const file of ['.env.local', '.env']) {
  if (!existsSync(file)) continue;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (!(k in process.env)) process.env[k] = v;
  }
}

const API_URL = (process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321').replace(/\/+$/, '');
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const DB_URL = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

if (!SERVICE_KEY) {
  console.error('\nSUPABASE_SERVICE_ROLE_KEY is not set.\n');
  process.exit(1);
}

// A distinct run id, so a second run against the same stack does not collide
// with the first on the project's unique name.
const RUN = randomBytes(3).toString('hex');
const OPERATOR = `verify-${RUN}@console`;
const EMAIL = `translator-${RUN}@verify.test`;
const OUTSIDER_EMAIL = `outsider-${RUN}@verify.test`;
const INITIAL_PASSWORD = randomBytes(12).toString('base64url');
const RESET_PASSWORD = randomBytes(12).toString('base64url');
const PROJECT_NAME = `Verification ${RUN}`;

console.log(`\n${DIM}run ${RUN} · ${API_URL}${RESET}`);

const db = new Client({
  connectionString: DB_URL,
  ssl: /[?&]sslmode=/.test(DB_URL) || /@(localhost|127\.0\.0\.1)[:/]/.test(DB_URL)
    ? undefined
    : { rejectUnauthorized: true },
  connectionTimeoutMillis: 10_000,
  statement_timeout: 120_000,
});

async function one(sql, params = []) {
  const { rows } = await db.query(sql, params);
  return rows[0] ?? null;
}
async function scalar(sql, params = []) {
  const row = await one(sql, params);
  return row ? Object.values(row)[0] : null;
}

async function admin(path, method, body) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { ok: res.ok, status: res.status, json, text };
}

/** Has this action been recorded against this operator? (DB R-AUTH-DB-12) */
async function auditedBy(action, targetId) {
  return scalar(
    `select count(*)::int from app.audit_log
      where action = $1 and target_id = $2::uuid
        and actor_kind = 'console' and actor_label = $3`,
    [action, targetId, OPERATOR],
  );
}

try {
  await db.connect();
} catch (err) {
  console.error(
    `\n${BAD}cannot connect to the database: ${err.message}\n` +
      '       Start a stack first, or check DATABASE_URL. `npm run check-stack`\n' +
      '       reports every dependency at once.\n',
  );
  process.exit(1);
}

let profileId = null;
let outsiderId = null;
let projectId = null;
let chapterId = null;

/**
 * Creates an account and returns its profile id.
 *
 * The profile arrives by trigger (DB R-AUTH-DB-6); an auth user without one can
 * sign in but is invisible to every query in the schema.
 */
async function provision(email, displayName, password) {
  const created = await admin('/auth/v1/admin/users', 'POST', {
    email,
    password,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (!created.ok || !created.json?.id) return { authUserId: null, profileId: null, created };
  const pid = await scalar('select id from app.profile where auth_user_id = $1', [
    created.json.id,
  ]);
  return { authUserId: created.json.id, profileId: pid, created };
}

try {
  // -------------------------------------------------------------------------
  section('Account provisioning (WEB §6.5)');
  // -------------------------------------------------------------------------

  const primary = await provision(EMAIL, `Verify ${RUN}`, INITIAL_PASSWORD);
  const authUserId = primary.authUserId;
  check(authUserId, 'admin API created a pre-confirmed account', primary.created.text);

  // A second account that is never added to any project. It exists so the
  // negative assertion in the assignment section has a genuine non-member to
  // use. Previously that check looked for "any other profile" and skipped
  // itself when a freshly reset database contained only one — a test that
  // silently does not run, which is the failure mode this suite exists to
  // catch elsewhere.
  const outsider = await provision(OUTSIDER_EMAIL, `Outsider ${RUN}`, INITIAL_PASSWORD);
  outsiderId = outsider.profileId;
  check(outsiderId, 'a non-member account exists for the negative assignment check');

  if (authUserId) {
    profileId = primary.profileId;
    check(profileId, 'the profile trigger produced a profile row');

    const mustChange = await scalar(
      'select must_change_password from app.profile where id = $1',
      [profileId],
    );
    // DB R-AUTH-DB-7: the initial password is known to two people; RLS withholds
    // all project content until it is changed.
    check(mustChange === true, 'must_change_password defaults to true');

    await db.query(
      `select app.console_audit('profile.create', 'profile', $1::uuid, $2, null::jsonb, $3::jsonb)`,
      [profileId, OPERATOR, JSON.stringify({ email: EMAIL })],
    );
    check(
      (await auditedBy('profile.create', profileId)) === 1,
      'account creation is recorded against the operator',
    );
  }

  // -------------------------------------------------------------------------
  section('Project creation (WEB §6.1)');
  // -------------------------------------------------------------------------

  const project = await scalar(
    `select api.create_project($1, $2, $3, $4, 'eng', 'ltr', array['MAT'], $5)`,
    [PROJECT_NAME, 'Verification Language', 'xx', 'Latn', OPERATOR],
  );
  projectId = project?.project_id ?? null;
  check(projectId, 'api.create_project returned a project');
  check(project?.books_materialised === 1, 'one book was materialised');

  // DB R-DATA-3: creating a project writes books, chapters, and empty verse
  // rows. A project that is an empty shell is the failure this catches.
  const verses = await scalar(
    'select count(*)::int from app.verse where project_id = $1', [projectId],
  );
  check(verses === 1071, `Matthew materialised in full (${verses} verses, expected 1071)`);

  check(
    (await auditedBy('project.create', projectId)) === 1,
    'project creation is recorded against the operator',
  );

  // An unseeded scheme must fail loudly rather than produce silently wrong
  // verse counts, discovered at export (DB R-DATA-2, WEB R-FN-WEB-3).
  let refused = false;
  try {
    await db.query(
      `select api.create_project($1, 'L', 'xx', 'Latn', 'org', 'ltr', array['MAT'], $2)`,
      [`Unseeded ${RUN}`, OPERATOR],
    );
  } catch (err) {
    refused = err.code === 'PT422' && err.message === 'versification_missing';
  }
  check(refused, 'an unseeded versification scheme is refused with a typed error');

  // -------------------------------------------------------------------------
  section('Membership (WEB §6.2)');
  // -------------------------------------------------------------------------

  if (profileId && projectId) {
    const added = await scalar('select api.add_project_member($1, $2, $3, $4)', [
      projectId, profileId, 'translator', OPERATOR,
    ]);
    check(added?.role === 'translator', 'member added as translator');
    check(added?.previous_role === null, 'and reported as new rather than changed');

    // The upsert IS the role-change path (WEB R-FN-WEB-6).
    const changed = await scalar('select api.add_project_member($1, $2, $3, $4)', [
      projectId, profileId, 'reviewer', OPERATOR,
    ]);
    check(
      changed?.previous_role === 'translator' && changed?.role === 'reviewer',
      'adding an existing member changes their role and reports the previous one',
    );

    await db.query('select api.add_project_member($1, $2, $3, $4)', [
      projectId, profileId, 'translator', OPERATOR,
    ]);
  }

  // -------------------------------------------------------------------------
  section('Assignment (WEB §6.3)');
  // -------------------------------------------------------------------------

  chapterId = await scalar(
    `select c.id from app.chapter c
       join app.book b on b.id = c.book_id
      where b.project_id = $1 and b.code = 'MAT' and c.number = 1`,
    [projectId],
  );
  check(chapterId, 'Matthew 1 exists to assign');

  if (chapterId && profileId) {
    const before = await scalar(
      'select coalesce(max(seq), 0) from app.change_log where project_id = $1', [projectId],
    );

    const assigned = await scalar('select api.assign_chapter($1, $2, null, $3)', [
      chapterId, profileId, OPERATOR,
    ]);
    check(assigned?.assigned_translator_id === profileId, 'chapter assigned to the translator');

    // THE ASSERTION THIS WHOLE SCRIPT EXISTS FOR.
    //
    // Assignment through raw SQL wrote no change-log entry, so a chapter
    // assigned by a coordinator never reached the translator's device: delta
    // sync is the only way the app learns anything changed. Migration 0015 was
    // written to fix exactly this, and nothing outside pgTAP has confirmed it.
    const logged = await one(
      `select entity_type, op from app.change_log
        where project_id = $1 and entity_id = $2::uuid and seq > $3
        order by seq desc limit 1`,
      [projectId, chapterId, before],
    );
    check(
      logged?.entity_type === 'chapter',
      'the assignment wrote a change-log entry, so it will reach the device',
      logged ? `got entity_type=${logged.entity_type}` : 'no change_log row was written',
    );

    check(
      (await auditedBy('chapter.assign', chapterId)) >= 1,
      'assignment is recorded against the operator',
    );

    // Assigning a non-member produces a chapter its assignee cannot read: the
    // app would show them nothing and the refusal would look like a bug rather
    // than a mis-assignment (WEB R-FN-WEB-10).
    //
    // Asserted unconditionally. If the outsider account is missing, that is a
    // failure of this script rather than a reason to skip the check.
    let rejected = false;
    let rejectionCode = null;
    try {
      await db.query('select api.assign_chapter($1, $2, null, $3)', [
        chapterId, outsiderId, OPERATOR,
      ]);
    } catch (err) {
      rejectionCode = `${err.code} ${err.message}`;
      rejected = err.code === 'PT400' && err.message === 'invalid_argument';
    }
    check(
      rejected,
      'assigning a non-member is refused with invalid_argument',
      rejectionCode ?? 'the assignment was ACCEPTED',
    );

    // The refused call must not have changed anything.
    const stillAssigned = await scalar(
      'select assigned_translator_id from app.chapter where id = $1', [chapterId],
    );
    check(
      stillAssigned === profileId,
      'and the existing assignment is untouched by the refusal',
    );

    // Clearing must be possible, and must not be an accident of the form
    // (WEB R-FN-WEB-9).
    const cleared = await scalar('select api.assign_chapter($1, null, null, $2)', [
      chapterId, OPERATOR,
    ]);
    check(
      cleared?.assigned_translator_id === null,
      'assignment can be cleared',
    );
    await db.query('select api.assign_chapter($1, $2, null, $3)', [
      chapterId, profileId, OPERATOR,
    ]);
  }

  // -------------------------------------------------------------------------
  section('Reopen (WEB §6.4)');
  // -------------------------------------------------------------------------

  if (chapterId) {
    // FIXTURE, not a console path. Reaching `approved` legitimately requires an
    // authenticated translator and reviewer moving through submit and review;
    // that is the app's journey and is covered by the database repository's own
    // tests. What is under test here is the way back.
    await db.query(
      `update app.chapter set workflow_state = 'approved', approved_at = now(),
              approved_by_id = $2, submitted_at = now()
        where id = $1`,
      [chapterId, profileId],
    );

    const reopened = await scalar('select api.reopen_chapter($1, $2, $3)', [
      chapterId, `verification run ${RUN}`, OPERATOR,
    ]);
    check(reopened?.workflow_state === 'in_progress', 'an approved chapter returns to in_progress');
    check(reopened?.approved_at === null, 'and the approval timestamp is discarded');

    const auditRow = await one(
      `select after from app.audit_log
        where action = 'chapter.reopen' and target_id = $1::uuid and actor_label = $2
        order by occurred_at desc limit 1`,
      [chapterId, OPERATOR],
    );
    // WEB R-POLICY-WEB-1: the note is the only record of why an approval was
    // undone, and the console requires one.
    check(
      auditRow?.after?.note === `verification run ${RUN}`,
      'the reason is preserved in the audit log',
    );

    // Reopening something that is not approved must be a typed refusal.
    let invalid = false;
    try {
      await db.query('select api.reopen_chapter($1, $2, $3)', [chapterId, 'again', OPERATOR]);
    } catch (err) {
      invalid = err.code === 'PT409' && err.message === 'invalid_transition';
    }
    check(invalid, 'reopening a chapter that is not approved raises invalid_transition');
  }

  // -------------------------------------------------------------------------
  section('Password reset (WEB §6.6)');
  // -------------------------------------------------------------------------

  if (profileId) {
    const authUser = await scalar(
      'select auth_user_id from app.profile where id = $1', [profileId],
    );

    // Clear the flag first, so re-arming it proves something.
    await db.query(
      'update app.profile set must_change_password = false where id = $1', [profileId],
    );
    const fingerprintBefore = await scalar(
      'select initial_password_fingerprint from app.profile where id = $1', [profileId],
    );

    const reset = await admin(`/auth/v1/admin/users/${authUser}`, 'PUT', {
      password: RESET_PASSWORD,
    });
    check(reset.ok, 'admin API set a new password', reset.text);

    const rearmed = await scalar('select api.rearm_password_change($1, $2)', [
      profileId, OPERATOR,
    ]);
    check(rearmed?.must_change_password === true, 'the forced change is re-armed');

    // DB R-AUTH-DB-7: re-fingerprinting is what makes complete_password_change
    // compare against the new hash rather than a stale one. Without it the
    // translator could clear the flag without changing anything.
    const fingerprintAfter = await scalar(
      'select initial_password_fingerprint from app.profile where id = $1', [profileId],
    );
    check(
      fingerprintAfter && fingerprintAfter !== fingerprintBefore,
      're-arming also re-fingerprints the new password hash',
    );

    check(
      (await auditedBy('profile.password_reset', profileId)) >= 1,
      'the reset is recorded against the operator',
    );

    // The account must actually be usable with the new password — the whole
    // point of the operation (APP R-AUTH-7).
    const signIn = await fetch(`${API_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: process.env.SUPABASE_ANON_KEY ?? SERVICE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email: EMAIL, password: RESET_PASSWORD }),
      signal: AbortSignal.timeout(20_000),
    });
    check(signIn.ok, 'the translator can sign in with the reset password');
  }

  // -------------------------------------------------------------------------
  section('USFM export (WEB §6.9)');
  // -------------------------------------------------------------------------

  if (projectId) {
    // The same query the console's export route runs, against a real
    // materialised book. The generator is unit-tested on fixtures in
    // scripts/test-usfm.mjs; what this adds is that it holds against 1,071
    // real verse rows produced by api.create_project rather than by hand.
    const rows = (await db.query(
      `select p.name as project_name, p.language_code,
              b.code as book_code, b.name as book_name,
              bc.name_en as canon_name, bc.sort_order, bc.testament,
              c.number as chapter_number, v.number as verse_number, v.text
         from app.book b
         join app.project p on p.id = b.project_id
         join ref.book_canon bc on bc.code = b.code
         join app.chapter c on c.book_id = b.id
         join app.verse v on v.chapter_id = c.id
        where b.project_id = $1 and b.code = 'MAT'
        order by c.number, v.number`,
      [projectId],
    )).rows;

    check(rows.length === 1071, `the export query returns every verse (${rows.length})`);

    const chapters = [];
    let cur = null;
    for (const row of rows) {
      if (!cur || cur.number !== row.chapter_number) {
        cur = { number: row.chapter_number, verses: [] };
        chapters.push(cur);
      }
      cur.verses.push({ number: row.verse_number, text: row.text });
    }

    const first = rows[0];
    const usfm = buildUsfm(
      { name: first.project_name, languageCode: first.language_code },
      {
        code: first.book_code, name: first.book_name, canonName: first.canon_name,
        sortOrder: first.sort_order, testament: first.testament, chapters,
      },
    );

    check(usfm.content.startsWith('\id MAT '), 'the file opens with the \id marker');
    check(usfm.stats.chapters === 28, `Matthew exports 28 chapters (${usfm.stats.chapters})`);
    check(
      (usfm.content.match(/^\c /gm) || []).length === 28,
      'every chapter emits a \c marker',
    );
    check(
      (usfm.content.match(/^\p$/gm) || []).length === 28,
      'every chapter opens a paragraph',
    );
    check(
      (usfm.content.match(/^\v /gm) || []).length === 1071,
      'every verse emits a \v marker',
    );
    // A freshly materialised project has no translated text, so this run also
    // covers the empty-verse path end to end.
    check(
      usfm.stats.emptyVerses === 1071,
      'an untranslated book exports as empty verse markers rather than dropping them',
    );
    check(
      /^41MAT[A-Z0-9]+\.usfm$/.test(usfm.filename),
      `the filename uses Paratext numbering (${usfm.filename})`,
    );
  }

  // -------------------------------------------------------------------------
  section('Audit trail (DB R-AUTH-DB-12)');
  // -------------------------------------------------------------------------

  const actions = await db.query(
    `select distinct action from app.audit_log where actor_label = $1 order by action`,
    [OPERATOR],
  );
  const seen = actions.rows.map((r) => r.action);
  for (const expected of [
    'profile.create', 'project.create', 'member.upsert', 'chapter.assign',
    'chapter.reopen', 'profile.password_reset',
  ]) {
    check(seen.includes(expected), `audit log contains ${expected}`);
  }

  const unlabelled = await scalar(
    `select count(*)::int from app.audit_log
      where actor_kind = 'console' and actor_label is null`,
  );
  check(
    unlabelled === 0,
    'no console action was recorded without an operator',
    `${unlabelled} console entries have no actor_label`,
  );

  // -------------------------------------------------------------------------
  if (process.env.CONSOLE_URL) {
    section('Console HTTP (WEB §9.2)');
    const base = process.env.CONSOLE_URL.replace(/\/+$/, '');

    const login = await fetch(`${base}/login`, { signal: AbortSignal.timeout(20_000) });
    const html = await login.text();
    check(login.ok && /Scripture Bridge Console/.test(html), 'the sign-in page is served');

    // An unauthenticated request for a console page must not return console
    // content. Redirect or refuse — either is correct; 200 with data is not.
    const guarded = await fetch(`${base}/projects`, {
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    check(
      guarded.status >= 300 && guarded.status < 400,
      'an unauthenticated request for /projects is redirected',
      `status ${guarded.status}`,
    );

    check(
      login.headers.get('x-frame-options') === 'DENY',
      'security headers are present',
      `x-frame-options: ${login.headers.get('x-frame-options')}`,
    );

    // The export route returns project content, so it carries its own session
    // check rather than relying on the layout it does not pass through
    // (WEB R-SEC-WEB-5). A cookie that exists but does not verify is the case
    // middleware cannot catch, so it is the one asserted here.
    const bookId = await scalar(
      `select id from app.book where project_id = $1 and code = 'MAT'`, [projectId],
    );
    const exportPath = `/projects/${projectId}/books/${bookId}/export`;

    const forged = await fetch(`${base}${exportPath}`, {
      headers: { cookie: 'sb_console_session=forged.notavalidsignature' },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    });
    check(
      forged.status >= 300 && forged.status < 400,
      'an export request with an unverifiable session cookie is refused',
      `status ${forged.status}`,
    );

    // A genuine session, minted with the secret this process already holds.
    //
    // The cookie format is duplicated from src/lib/session.ts rather than
    // imported: that module pulls in `server-only` and next/headers and cannot
    // load outside Next. The duplication is deliberate and small; if the format
    // changes, this assertion fails, which is the outcome worth having.
    const operatorEmail = (process.env.CONSOLE_OPERATORS ?? '').split(',')[0].trim().toLowerCase();
    const secret = process.env.CONSOLE_SESSION_SECRET;

    if (operatorEmail && secret) {
      const payload = Buffer.from(JSON.stringify({
        email: operatorEmail,
        authUserId: '00000000-0000-0000-0000-000000000000',
        expiresAt: Math.floor(Date.now() / 1000) + 600,
      })).toString('base64url');
      const sig = createHmac('sha256', secret).update(payload).digest('base64url');

      const res = await fetch(`${base}${exportPath}`, {
        headers: { cookie: `sb_console_session=${payload}.${sig}` },
        signal: AbortSignal.timeout(60_000),
      });
      check(res.status === 200, 'an authenticated export returns the file', `status ${res.status}`);

      const disposition = res.headers.get('content-disposition') ?? '';
      check(
        /attachment; filename="41MAT[A-Z0-9]+\.usfm"/.test(disposition),
        'it is served as a download with a Paratext filename',
        disposition,
      );

      const body = await res.text();
      check(body.startsWith('\id MAT '), 'the downloaded file opens with the \id marker');
      check(
        (body.match(/^\v /gm) || []).length === 1071,
        'the downloaded file carries every verse',
      );
      check(
        (res.headers.get('x-usfm-warnings') ?? '').includes('Structurally plain'),
        'the response carries the structurally-plain caveat',
      );

      // Export is read-only but removes translation text from the system, and
      // "who took a copy, and when" is asked after the fact or not at all.
      const exported = await scalar(
        `select count(*)::int from app.audit_log
          where action = 'book.export' and target_id = $1::uuid
            and actor_label = $2`,
        [bookId, `${operatorEmail}@console`],
      );
      check(exported === 1, 'the export is recorded in the audit log against the operator');
    } else {
      fail('CONSOLE_OPERATORS or CONSOLE_SESSION_SECRET is unset; the export route was not exercised');
    }
  }
} catch (err) {
  fail('the sequence stopped on an unexpected error', err.stack ?? String(err));
} finally {
  await db.end();
}

// ---------------------------------------------------------------------------

console.log(`\n${DIM}left behind: project "${PROJECT_NAME}", account ${EMAIL}${RESET}`);
if (failures > 0) {
  console.log(`\n[31m${failures} check(s) failed.[0m M4 is not met.\n`);
  process.exit(1);
}
console.log('\n[32mThe M4 verification sequence passed.[0m\n');
