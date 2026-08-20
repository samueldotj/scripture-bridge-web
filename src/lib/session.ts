import 'server-only';
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { config } from './env';

/**
 * The console's own session.
 *
 * An operator is an ordinary auth user who additionally appears in
 * CONSOLE_OPERATORS. Their GoTrue password is verified once at sign-in and the
 * tokens are then discarded: the console never reads project data with an
 * operator's JWT, because RLS would show a non-member nothing, and holding a
 * refresh token for a privileged human is a liability with no benefit here.
 *
 * What the cookie carries instead is a signed assertion of who is at the
 * keyboard. That assertion becomes the `p_operator` label on every `api.*`
 * call, which is what turns the audit trail from "a console did this" into
 * "this coordinator did this" (DB R-AUTH-DB-12).
 */

const COOKIE_NAME = 'sb_console_session';

export interface Session {
  /** Operator email, lowercased. Written to app.audit_log.actor_label. */
  email: string;
  /** Their auth.users id. Recorded so a session survives an email change. */
  authUserId: string;
  /** Unix seconds. */
  expiresAt: number;
}

function sign(payload: string): string {
  return createHmac('sha256', config().sessionSecret).update(payload).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on a length mismatch, which is itself a leak of
  // nothing useful but an exception we would rather not handle at the call site.
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function encode(session: Session): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decode(token: string): Session | null {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  if (!safeEqual(signature, sign(payload))) return null;

  try {
    const parsed: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    const s = parsed as Partial<Session>;
    if (typeof s.email !== 'string' || typeof s.authUserId !== 'string') return null;
    if (typeof s.expiresAt !== 'number' || s.expiresAt * 1000 < Date.now()) return null;
    return { email: s.email, authUserId: s.authUserId, expiresAt: s.expiresAt };
  } catch {
    return null;
  }
}

export async function createSession(email: string, authUserId: string): Promise<void> {
  const { sessionHours } = config();
  const session: Session = {
    email: email.trim().toLowerCase(),
    authUserId,
    expiresAt: Math.floor(Date.now() / 1000) + sessionHours * 3600,
  };

  const store = await cookies();
  store.set(COOKIE_NAME, encode(session), {
    httpOnly: true,
    sameSite: 'lax',
    // Set over plain HTTP in local development only; anywhere else this cookie
    // is a bearer token for service-key-backed operations.
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: sessionHours * 3600,
  });
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

/** The current session, or null. Signature and expiry are both checked. */
export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;

  const session = decode(raw);
  if (!session) return null;

  // The allowlist is re-checked on every request, not just at sign-in. Removing
  // an operator from CONSOLE_OPERATORS must take effect on the next click, not
  // whenever their eight-hour cookie happens to lapse.
  const { operators } = config();
  if (!operators.has(session.email)) return null;

  return session;
}

/**
 * The session, or a thrown error.
 *
 * Every Server Action calls this first. A page that forgot its guard renders
 * nothing sensitive; an action that forgot its guard would perform a privileged
 * write, so the guard is placed where the write is.
 */
export async function requireSession(): Promise<Session> {
  const session = await getSession();
  if (!session) {
    throw new Error('Your session has expired. Sign in again.');
  }
  return session;
}

/**
 * The label recorded against every console action.
 *
 * `provision.sh` uses `<user>@provision.sh`; the suffix here says the same
 * thing about origin, so an audit reader can tell a console action from a
 * script action without consulting a second system.
 */
export function operatorLabel(session: Session): string {
  return `${session.email}@console`;
}

/** Used to generate a suggested initial password in the account form. */
export function suggestPassword(): string {
  // 18 bytes of base64url: no ambiguous-character substitution, because this
  // string is transcribed by hand onto paper and read back over a phone line.
  // Removing lookalikes shrinks the alphabet; length is the cheaper fix.
  return randomBytes(18).toString('base64url');
}
