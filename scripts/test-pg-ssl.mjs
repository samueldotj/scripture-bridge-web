#!/usr/bin/env node
/**
 * Unit tests for the Postgres TLS decision (WEB R-OPS-WEB-10).
 *
 * Three programs connect to the same database — the console, the preflight,
 * and the verification sequence — and they share `sslConfig` so the decision
 * exists once. These tests are what stop it drifting: a change that quietly
 * turned verification off would otherwise be invisible until someone read the
 * diff, and the symptom of getting it wrong in the other direction is a
 * connection failure whose message names a certificate rather than a mistake.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sslConfig, explainTlsFailure } from '../src/lib/pg-ssl.ts';

const HOSTED = 'postgresql://postgres.abc:pw@aws-0-ap-south-1.pooler.supabase.com:5432/postgres';
const LOCAL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

test('a loopback stack gets no TLS', () => {
  // The local Supabase stack speaks plaintext; requiring TLS there fails for
  // no gain.
  assert.equal(sslConfig(LOCAL, {}), undefined);
  assert.equal(sslConfig('postgresql://postgres:postgres@localhost:54322/postgres', {}), undefined);
});

test('a hosted host verifies by default', () => {
  // The default must be strict. Getting this wrong is silent: the connection
  // still works, and it is merely unauthenticated.
  assert.deepEqual(sslConfig(HOSTED, {}), { rejectUnauthorized: true });
});

test('an explicit sslmode in the URL is left to the driver', () => {
  // This is how `no-verify` is requested, and deferring keeps every libpq mode
  // available without reimplementing them here.
  assert.equal(sslConfig(`${HOSTED}?sslmode=no-verify`, {}), undefined);
  assert.equal(sslConfig(`${HOSTED}?sslmode=verify-full`, {}), undefined);
});

test('a CA certificate is used and verification stays on', () => {
  const pem = '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----';
  const result = sslConfig(HOSTED, { DATABASE_CA_CERT: pem });
  assert.equal(result.rejectUnauthorized, true);
  assert.equal(result.ca, pem);
});

test('an empty CA variable does not disable verification', () => {
  // A variable set to "" is a configuration mistake, not a request to trust
  // anything.
  assert.deepEqual(sslConfig(HOSTED, { DATABASE_CA_CERT: '   ' }), {
    rejectUnauthorized: true,
  });
});

test('a CA path that does not exist fails loudly', () => {
  assert.throws(
    () => sslConfig(HOSTED, { DATABASE_CA_CERT: '/no/such/ca.crt' }),
    /neither a PEM certificate nor a file that exists/,
  );
});

test('a malformed URL still gets strict TLS rather than none', () => {
  // Failing open here would mean an unparsable URL silently downgraded the
  // connection.
  assert.deepEqual(sslConfig('not a url', {}), { rejectUnauthorized: true });
});

test('the TLS explanation fires on the message Supabase actually produces', () => {
  const message = 'self-signed certificate in certificate chain';
  const explanation = explainTlsFailure(message);
  assert.ok(explanation);
  assert.ok(explanation.includes('DATABASE_CA_CERT'));
  assert.ok(explanation.includes('sslmode=no-verify'));
  // The advice that cost a round trip: `require` verifies in this driver.
  assert.ok(explanation.includes('does NOT work'));
});

test('the TLS explanation stays silent on unrelated failures', () => {
  // "connection refused" must not be answered with a lecture about certificates.
  assert.equal(explainTlsFailure('connect ECONNREFUSED 127.0.0.1:54322'), null);
  assert.equal(explainTlsFailure('password authentication failed'), null);
});
