#!/usr/bin/env node
/**
 * The cross-repository schema guard (WEB R-TEST-WEB-3).
 *
 * The console composes SQL in template literals. TypeScript cannot check a
 * string, so a column renamed in `scripture-bridge-db` becomes a runtime error
 * found by a coordinator rather than a build error found by CI. WEB roadmap §8
 * calls this the check most likely to rot, because it has to be repeated on
 * every migration added to a repository this one does not control.
 *
 *   npm run check-schema
 *   SB_DB_REPO=../scripture-bridge-db npm run check-schema
 *
 * It parses the migrations into a schema model, extracts every table, column,
 * and function reference from the console's SQL, and reports what no longer
 * resolves.
 *
 * WHAT IT DOES NOT DO: this is not a SQL parser, and it does not need to be.
 * It reads SQL written in one repository, in a house style it can rely on —
 * every table reference qualified with its schema, every table given an alias,
 * every column reference qualified with that alias. Where it cannot resolve
 * something it says so and skips it, rather than guessing. Unresolved
 * references are reported at the end so that a query written in some other
 * style is visible as a gap in coverage instead of passing silently.
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const OK = '  [32mok[0m   ';
const BAD = '  [31mFAIL[0m ';
const DIM = '[2m';
const RESET = '[0m';

let failures = 0;
const unresolved = [];

function fail(msg, detail) {
  failures += 1;
  console.log(BAD + msg);
  if (detail) console.log('       ' + detail);
}

// ---------------------------------------------------------------------------
// Locate the database repository
// ---------------------------------------------------------------------------

const dbRepo = process.env.SB_DB_REPO ?? '../scripture-bridge-db';
const migrationsDir = join(dbRepo, 'supabase', 'migrations');

if (!existsSync(migrationsDir)) {
  console.error(
    `\nNo migrations at ${migrationsDir}.\n\n` +
      'Point SB_DB_REPO at a checkout of scripture-bridge-db:\n' +
      '  SB_DB_REPO=/path/to/scripture-bridge-db npm run check-schema\n',
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Strip what would confuse a bracket counter
//
// Migration bodies are heavily commented, and several comments contain commas
// and parentheses — a naive split would read "-- ON DELETE SET NULL, never
// CASCADE" as two column definitions. Dollar-quoted function bodies contain
// entire programs. Both are replaced with whitespace; string literals are
// emptied so their contents cannot affect depth.
// ---------------------------------------------------------------------------

function clean(sql) {
  let out = '';
  let i = 0;

  while (i < sql.length) {
    const two = sql.slice(i, i + 2);

    if (two === '--') {
      while (i < sql.length && sql[i] !== '\n') i += 1;
      continue;
    }
    if (two === '/*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
      continue;
    }
    if (sql[i] === "'") {
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      out += "''";
      continue;
    }
    // Dollar quoting: $$ or $tag$. Whatever opens it must close it.
    const dollar = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i));
    if (dollar) {
      const tag = dollar[0];
      const end = sql.indexOf(tag, i + tag.length);
      i = end === -1 ? sql.length : end + tag.length;
      out += ' ';
      continue;
    }
    out += sql[i];
    i += 1;
  }
  return out;
}

/** Returns the text between the parenthesis at `open` and its match. */
function balanced(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i };
    }
  }
  return null;
}

/** Splits on commas that are not inside brackets. */
function topLevelSplit(text, brackets = '()') {
  const [open, close] = brackets;
  const parts = [];
  let depth = 0;
  let current = '';
  for (const ch of text) {
    if (ch === open || ch === '[') depth += 1;
    else if (ch === close || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) { parts.push(current); current = ''; continue; }
    current += ch;
  }
  if (current.trim() !== '') parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

// ---------------------------------------------------------------------------
// Build the schema model from the migrations
// ---------------------------------------------------------------------------

/** qualified table name -> Set of column names */
const tables = new Map();
/** qualified function name -> [{ required, total }] (one per overload) */
const functions = new Map();

/**
 * `auth` is GoTrue's schema, owned by the Supabase platform and absent from
 * these migrations. The console reads three of its columns. They are declared
 * here rather than skipped, so that a typo in one is still caught — and listed
 * explicitly, so that the dependency on a schema nobody in this project
 * controls is visible rather than implicit.
 */
tables.set('auth.users', new Set(['id', 'email', 'last_sign_in_at', 'created_at', 'encrypted_password', 'updated_at']));

const CONSTRAINT_WORDS = new Set([
  'primary', 'unique', 'foreign', 'check', 'constraint', 'exclude', 'like', 'partition',
]);

const migrationFiles = readdirSync(migrationsDir)
  .filter((f) => f.endsWith('.sql'))
  .sort();

for (const file of migrationFiles) {
  const raw = readFileSync(join(migrationsDir, file), 'utf8');
  const sql = clean(raw);

  // create table <schema>.<name> ( ... )
  const tableRe = /create\s+table\s+(?:if\s+not\s+exists\s+)?(\w+)\.(\w+)\s*\(/gi;
  let m;
  while ((m = tableRe.exec(sql)) !== null) {
    const qualified = `${m[1]}.${m[2]}`;
    const block = balanced(sql, tableRe.lastIndex - 1);
    if (!block) continue;

    const columns = new Set();
    for (const part of topLevelSplit(block.body)) {
      const first = part.split(/\s+/)[0]?.toLowerCase();
      if (!first || CONSTRAINT_WORDS.has(first)) continue;
      if (/^[a-z_]\w*$/.test(first)) columns.add(first);
    }
    tables.set(qualified, columns);
  }

  // alter table ... add column [if not exists] <name>
  const alterRe =
    /alter\s+table\s+(?:if\s+exists\s+)?(\w+)\.(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi;
  while ((m = alterRe.exec(sql)) !== null) {
    const qualified = `${m[1]}.${m[2]}`;
    if (!tables.has(qualified)) tables.set(qualified, new Set());
    tables.get(qualified).add(m[3].toLowerCase());
  }

  // create [or replace] function <schema>.<name>( ... )
  const fnRe = /create\s+(?:or\s+replace\s+)?function\s+(\w+)\.(\w+)\s*\(/gi;
  while ((m = fnRe.exec(sql)) !== null) {
    const qualified = `${m[1]}.${m[2]}`;
    const block = balanced(sql, fnRe.lastIndex - 1);
    if (!block) continue;

    const params = topLevelSplit(block.body);
    const total = params.length;
    const required = params.filter((p) => !/\bdefault\b/i.test(p)).length;
    functions.set(qualified, { required, total });
  }
}

console.log(
  `\nSchema model from ${migrationFiles.length} migration(s) in ${relative('.', migrationsDir) || migrationsDir}`,
);
console.log(
  `${DIM}  ${tables.size} tables, ${functions.size} functions${RESET}\n`,
);

// ---------------------------------------------------------------------------
// Extract what the console references
// ---------------------------------------------------------------------------

function sourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, out);
    else if (/\.tsx?$/.test(path)) out.push(path);
  }
  return out;
}

const SQL_START = /\b(select|insert\s+into|update|delete\s+from|with)\b/i;

/** Template literals that look like SQL, with simple `${CONST}` references resolved. */
function extractSql(text) {
  const literals = [...text.matchAll(/`([^`]*)`/g)].map((m) => m[1]);

  // const NAME = `...` — so that a query assembled from a shared fragment is
  // checked as the query that actually runs.
  const consts = new Map();
  for (const m of text.matchAll(/const\s+([A-Z][A-Z0-9_]*)\s*=\s*`([^`]*)`/g)) {
    consts.set(m[1], m[2]);
  }

  return literals
    .map((lit) =>
      lit.replace(/\$\{(\w+)\}/g, (whole, name) => consts.get(name) ?? whole),
    )
    .filter((lit) => SQL_START.test(lit));
}

/** Words that follow a table name but are not an alias. */
const NOT_AN_ALIAS = new Set([
  'on', 'where', 'group', 'order', 'limit', 'offset', 'using', 'left', 'right',
  'inner', 'outer', 'full', 'cross', 'join', 'lateral', 'and', 'or', 'set',
  'returning', 'having', 'union', 'as', 'select', 'from', 'values', 'natural',
]);

const files = sourceFiles('src');
let sqlCount = 0;
let refCount = 0;

for (const file of files) {
  const text = readFileSync(file, 'utf8');
  const statements = extractSql(text);

  for (const sql of statements) {
    sqlCount += 1;
    const lower = sql.toLowerCase();

    // ---- table references and their aliases
    const aliases = new Map();
    const referenced = new Set();
    const tableRe =
      /\b(?:from|join|into|update)\s+(app|api|ref|auth)\.(\w+)(?:\s+(?:as\s+)?([a-z_]\w*))?/gi;
    let m;
    while ((m = tableRe.exec(lower)) !== null) {
      const qualified = `${m[1]}.${m[2]}`;
      referenced.add(qualified);
      const alias = m[3] && !NOT_AN_ALIAS.has(m[3]) ? m[3] : m[2];

      const existing = aliases.get(alias);
      if (existing && existing !== qualified) {
        // Two tables behind one alias in one statement. The checker would have
        // to pick, and picking wrongly is worse than declining.
        aliases.set(alias, null);
      } else if (!existing) {
        aliases.set(alias, qualified);
      }
    }

    for (const qualified of referenced) {
      refCount += 1;
      if (!tables.has(qualified)) {
        fail(`${qualified} does not exist`, `${file}`);
      }
    }

    // ---- qualified column references
    for (const cm of lower.matchAll(/\b([a-z_]\w*)\.([a-z_]\w*)\b/g)) {
      const [, prefix, column] = cm;
      if (['app', 'api', 'ref', 'auth', 'pg_catalog', 'information_schema'].includes(prefix)) {
        continue; // a table or function reference, handled elsewhere
      }
      const qualified = aliases.get(prefix);
      if (qualified === undefined) continue; // not an alias we bound: a subquery, or not SQL
      if (qualified === null) {
        unresolved.push(`${file}: alias "${prefix}" is ambiguous in one statement`);
        continue;
      }
      const columns = tables.get(qualified);
      if (!columns) continue; // the table failure is already reported
      refCount += 1;
      if (!columns.has(column)) {
        fail(`${qualified} has no column "${column}"`, `${file}  (as ${prefix}.${column})`);
      }
    }

    // ---- functions called inline, e.g. select app.console_audit(...)
    const callRe = /\b(app|api|ref)\.(\w+)\s*\(/gi;
    while ((m = callRe.exec(sql)) !== null) {
      const qualified = `${m[1]}.${m[2]}`;
      if (tables.has(qualified)) continue; // a table, not a call
      const block = balanced(sql, callRe.lastIndex - 1);
      const arity = block ? topLevelSplit(block.body).length : null;
      checkFunction(qualified, arity, file);
    }
  }

  // ---- functions called through callRpc('api.fn', [args])
  for (const m of text.matchAll(/callRpc\s*(?:<[^>]*>)?\s*\(\s*'([\w.]+)'\s*,\s*\[([\s\S]*?)\]/g)) {
    checkFunction(m[1], topLevelSplit(m[2]).length, file);
  }
}

function checkFunction(qualified, arity, file) {
  refCount += 1;
  const signature = functions.get(qualified);
  if (!signature) {
    fail(`${qualified}() does not exist`, file);
    return;
  }
  if (arity === null) return;
  if (arity < signature.required || arity > signature.total) {
    fail(
      `${qualified}() called with ${arity} argument(s)`,
      `${file}  (accepts ${signature.required}–${signature.total})`,
    );
  }
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------

console.log(
  `${DIM}Checked ${refCount} reference(s) across ${sqlCount} statement(s) in ${files.length} file(s)${RESET}`,
);

if (unresolved.length > 0) {
  console.log('\nNot checked:');
  for (const u of [...new Set(unresolved)]) console.log(`  ${DIM}${u}${RESET}`);
}

console.log('');
if (failures > 0) {
  console.log(
    `[31m${failures} reference(s) no longer resolve.[0m ` +
      'The console and the migrations have diverged.\n',
  );
  process.exit(1);
}
console.log(OK.trim() + ' every table, column, and function the console uses exists.\n');
