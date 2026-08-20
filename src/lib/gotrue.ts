import 'server-only';
import { config } from './env';
import { ConsoleError } from './errors';

/**
 * The GoTrue admin API.
 *
 * Accounts are created here rather than by writing to `auth.users`, because
 * that is how production does it (DB R-AUTH-DB-5) and because direct writes
 * couple the console to GoTrue's internal schema. The profile row arrives by
 * trigger (R-AUTH-DB-6).
 *
 * This is the only place the service key is used. It bypasses RLS entirely, so
 * it is never logged, never returned, and never placed in a response body.
 */

const AUTH_TIMEOUT_MS = 15_000;

interface GoTrueUser {
  id: string;
  email?: string;
  created_at?: string;
  last_sign_in_at?: string | null;
  banned_until?: string | null;
}

async function authFetch(
  path: string,
  init: RequestInit & { key: string },
): Promise<Response> {
  const { supabaseUrl } = config();
  const { key, ...rest } = init;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AUTH_TIMEOUT_MS);
  try {
    return await fetch(`${supabaseUrl}${path}`, {
      ...rest,
      cache: 'no-store',
      signal: controller.signal,
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        ...(rest.headers ?? {}),
      },
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError'
      ? `The auth service did not respond within ${AUTH_TIMEOUT_MS / 1000}s.`
      : `Could not reach the auth service at ${supabaseUrl}.`;
    throw new ConsoleError({
      code: 'auth_unreachable',
      status: 503,
      details: null,
      message: reason,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GoTrue's own error envelope, normalised. The body is read for a message but
 * never echoed wholesale: it can contain the submitted email and, on some
 * paths, the password that was rejected (DB R-ERR-4).
 */
async function gotrueError(res: Response, fallback: string): Promise<ConsoleError> {
  let detail = '';
  try {
    const body: unknown = await res.json();
    if (body && typeof body === 'object') {
      const b = body as Record<string, unknown>;
      const candidate = b.msg ?? b.message ?? b.error_description ?? b.error;
      if (typeof candidate === 'string') detail = candidate;
    }
  } catch {
    /* a non-JSON body tells us nothing worth surfacing */
  }
  return new ConsoleError({
    code: res.status === 429 ? 'rate_limited' : 'auth_error',
    status: res.status,
    details: null,
    message: detail ? `${fallback} (${detail})` : fallback,
  });
}

/**
 * Creates a pre-confirmed account.
 *
 * `email_confirm: true` because identifiers may be synthetic addresses on a
 * project-controlled domain (APP R-AUTH-2): no confirmation mail can be
 * delivered, and none is ever sent to a translator (R-AUTH-DB-3).
 *
 * `must_change_password` is left at its default of true. The initial password
 * is known to at least two people by construction, and the app must force a
 * change before any project data is readable — a gate enforced in RLS, not in
 * navigation (R-AUTH-DB-8).
 */
export async function createAuthUser(
  email: string,
  password: string,
  displayName: string,
): Promise<{ id: string }> {
  const res = await authFetch('/auth/v1/admin/users', {
    key: config().serviceRoleKey,
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      email_confirm: true,
      user_metadata: { display_name: displayName },
    }),
  });

  if (!res.ok) {
    throw await gotrueError(res, `Could not create the account for ${email}.`);
  }
  const user = (await res.json()) as GoTrueUser;
  if (!user.id) {
    throw new ConsoleError({
      code: 'auth_error',
      status: 502,
      details: null,
      message: 'The auth service accepted the account but returned no id.',
    });
  }
  return { id: user.id };
}

/**
 * Sets a new password for someone else (APP R-AUTH-7).
 *
 * Self-service recovery cannot work against synthetic addresses and is left
 * disabled, so this is the only thing standing between a translator and
 * permanent lockout. Re-arming the forced change is a separate step performed
 * by `api.rearm_password_change`, and both must happen — see actions/accounts.
 */
export async function setUserPassword(
  authUserId: string,
  password: string,
): Promise<void> {
  const res = await authFetch(`/auth/v1/admin/users/${authUserId}`, {
    key: config().serviceRoleKey,
    method: 'PUT',
    body: JSON.stringify({ password }),
  });
  if (!res.ok) {
    throw await gotrueError(res, 'Could not set the new password.');
  }
}

/**
 * Verifies an operator's own credentials.
 *
 * Uses the ANON key and the ordinary password grant: the console does not
 * hold a second credential store, and an operator is an ordinary auth user
 * who additionally appears in CONSOLE_OPERATORS. The tokens returned are
 * discarded — the console's own session cookie carries authority from here on,
 * and no project data is ever read with the operator's JWT.
 */
export async function verifyOperatorPassword(
  email: string,
  password: string,
): Promise<{ ok: true; authUserId: string } | { ok: false; rateLimited: boolean }> {
  const res = await authFetch('/auth/v1/token?grant_type=password', {
    key: config().anonKey,
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    return { ok: false, rateLimited: res.status === 429 };
  }
  const body = (await res.json()) as { user?: GoTrueUser };
  const id = body.user?.id;
  if (!id) return { ok: false, rateLimited: false };
  return { ok: true, authUserId: id };
}
