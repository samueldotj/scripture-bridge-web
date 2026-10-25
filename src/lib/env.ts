import 'server-only';

/**
 * Configuration, read once and validated loudly.
 *
 * Every value here is a secret or points at one. Nothing in this module may be
 * imported from a Client Component: `server-only` turns that mistake into a
 * build error rather than a service key in a browser bundle (DB R-RLS-3).
 *
 * No NEXT_PUBLIC_* variable exists in this project, deliberately. The console
 * has no legitimate need to hand the browser a Supabase credential of any
 * kind; the browser talks only to this server.
 */

class ConfigError extends Error {}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new ConfigError(
      `${name} is not set. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== '' ? value.trim() : fallback;
}

/**
 * Operators are identified by email and matched case-insensitively, because a
 * coordinator typing `Coordinator@example.org` at 2am in a field office should
 * not be told their credentials are wrong.
 */
function operatorAllowlist(): ReadonlySet<string> {
  const raw = required('CONSOLE_OPERATORS');
  const emails = raw
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e !== '');
  if (emails.length === 0) {
    throw new ConfigError('CONSOLE_OPERATORS is set but lists no addresses.');
  }
  return new Set(emails);
}

function sessionSecret(): string {
  const secret = required('CONSOLE_SESSION_SECRET');
  // 32 bytes of entropy is the floor for an HMAC key that signs a cookie
  // granting service-key-backed powers.
  if (secret.length < 32) {
    throw new ConfigError(
      'CONSOLE_SESSION_SECRET must be at least 32 characters. ' +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
    );
  }
  return secret;
}

/**
 * Connection pool ceiling, per process.
 *
 * A long-lived instance (WEB R-OPS-WEB-7) can hold a real pool. On a serverless
 * host every warm function instance holds its own, and five each is how a
 * handful of concurrent coordinators exhausts the pooler's client limit
 * (R-OPS-WEB-8). Vercel sets VERCEL=1 in every build and function, so the
 * default follows the host; DATABASE_POOL_MAX overrides either.
 */
function poolMax(): number {
  const fallback = process.env.VERCEL ? '2' : '5';
  const n = Number(optional('DATABASE_POOL_MAX', fallback));
  if (!Number.isInteger(n) || n < 1 || n > 50) {
    throw new ConfigError(
      'DATABASE_POOL_MAX must be a whole number between 1 and 50.',
    );
  }
  return n;
}

let cached: Config | null = null;

export interface Config {
  /** Postgres connection string. The console's read and RPC path. */
  databaseUrl: string;
  /** Pool ceiling per process: 2 on Vercel, 5 elsewhere, or DATABASE_POOL_MAX. */
  poolMax: number;
  /** Supabase API origin, e.g. https://abcd.supabase.co or http://127.0.0.1:54321. */
  supabaseUrl: string;
  /** Service key. Used ONLY for the GoTrue admin API. Never leaves this process. */
  serviceRoleKey: string;
  /** Anon key. Used ONLY to verify an operator's own password at sign-in. */
  anonKey: string;
  operators: ReadonlySet<string>;
  sessionSecret: string;
  sessionHours: number;
}

export function config(): Config {
  if (cached) return cached;
  cached = {
    databaseUrl: required('DATABASE_URL'),
    poolMax: poolMax(),
    supabaseUrl: required('SUPABASE_URL').replace(/\/+$/, ''),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),
    anonKey: required('SUPABASE_ANON_KEY'),
    operators: operatorAllowlist(),
    sessionSecret: sessionSecret(),
    sessionHours: Number(optional('CONSOLE_SESSION_HOURS', '8')) || 8,
  };
  return cached;
}

export function isOperator(email: string): boolean {
  return config().operators.has(email.trim().toLowerCase());
}
