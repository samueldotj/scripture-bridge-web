import { readFileSync, existsSync } from 'node:fs';

/**
 * TLS configuration for the Postgres connection.
 *
 * Pure and free of `server-only` so the preflight and the verification
 * sequence can share it. Three programs connect to the same database; a TLS
 * decision made three times is a TLS decision that will differ in one of them,
 * and the one that differs will be the one nobody runs until the pilot.
 *
 * WHY THIS IS NOT JUST `rejectUnauthorized: false`
 *
 * Supabase's pooler presents a chain that Node's default CA store does not
 * trust, so strict verification fails with "self-signed certificate in
 * certificate chain". The quick fix is to stop verifying. This connection
 * carries every project's translation text and is made by the one component
 * holding the service key, so an unauthenticated TLS session is a poor default
 * — it is encrypted against a passive observer and worthless against an active
 * one.
 *
 * So verification stays on, and the CA is supplied. Supabase publishes the
 * certificate at Settings -> Database -> SSL Configuration.
 *
 * `sslmode=no-verify` in the URL remains available as a deliberate, visible
 * opt-out. It is spelled out in the connection string rather than hidden in
 * code, so anyone reading the configuration can see that verification is off.
 */

export type PgSsl = undefined | { rejectUnauthorized: boolean; ca?: string };

function hostOf(databaseUrl: string): string {
  try {
    return new URL(databaseUrl).hostname;
  } catch {
    return '';
  }
}

/** Reads the CA as either a path to a PEM file or the PEM itself. */
function readCa(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('-----BEGIN')) return trimmed;
  if (existsSync(trimmed)) return readFileSync(trimmed, 'utf8');
  throw new Error(
    `DATABASE_CA_CERT is set but is neither a PEM certificate nor a file that exists: ${trimmed}`,
  );
}

export function sslConfig(
  databaseUrl: string,
  env: Record<string, string | undefined> = process.env,
): PgSsl {
  const host = hostOf(databaseUrl);
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';

  // A local stack speaks plaintext on a loopback interface. Requiring TLS there
  // would fail for no gain.
  if (isLoopback) return undefined;

  // An explicit sslmode in the URL wins, and is how `no-verify` is requested.
  // Deferring to the driver keeps every libpq mode available without this
  // function having to reimplement them.
  if (/[?&]sslmode=/.test(databaseUrl)) return undefined;

  const ca = env.DATABASE_CA_CERT;
  if (ca && ca.trim() !== '') {
    return { rejectUnauthorized: true, ca: readCa(ca) };
  }

  return { rejectUnauthorized: true };
}

/**
 * Turns a TLS failure into the sentence that resolves it.
 *
 * The driver's message is accurate and useless: "self-signed certificate in
 * certificate chain" is true of every hosted Supabase project and says nothing
 * about what to do. This is the first error anyone pointing the console at a
 * real project will see, so it is the one worth writing out in full.
 */
export function explainTlsFailure(message: string): string | null {
  if (!/self-signed certificate|unable to verify|SELF_SIGNED_CERT/i.test(message)) {
    return null;
  }
  return [
    'The database refused TLS verification. This is expected against a hosted',
    'Supabase project: its chain is not in Node\'s default CA store.',
    '',
    'Fix it in one of two ways:',
    '',
    '  1. Verify properly (recommended). Download the certificate from',
    '     Settings -> Database -> SSL Configuration, then set:',
    '       DATABASE_CA_CERT=/path/to/prod-ca-2021.crt',
    '',
    '  2. Skip verification, deliberately and visibly, by appending',
    '     ?sslmode=no-verify to DATABASE_URL. The connection stays encrypted',
    '     but is not authenticated.',
    '',
    'Note: ?sslmode=require does NOT work here. This driver verifies on',
    '`require`, unlike libpq, so it fails the same way.',
  ].join('\n');
}
