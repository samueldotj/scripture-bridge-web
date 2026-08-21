'use server';

import { redirect } from 'next/navigation';
import { isOperator } from '@/lib/env';
import { verifyOperatorPassword } from '@/lib/gotrue';
import { createSession, destroySession } from '@/lib/session';
import { checkRateLimit, clearRateLimit } from '@/lib/rate-limit';
import { failure, type ActionResult } from '@/lib/errors';

export async function signIn(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!email || !password) {
    return { ok: false, message: 'Enter an email address and password.' };
  }

  const limit = checkRateLimit(`signin:${email}`);
  if (!limit.allowed) {
    return {
      ok: false,
      message: `Too many attempts. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  // The allowlist is checked BEFORE the password, but the refusal is worded
  // identically either way. Telling an unlisted address that its password was
  // correct would confirm both an account and its credentials to someone who
  // has no business here.
  const allowed = isOperator(email);

  let result: Awaited<ReturnType<typeof verifyOperatorPassword>>;
  try {
    result = await verifyOperatorPassword(email, password);
  } catch (err) {
    // An unreachable auth service, or configuration that cannot be read, must
    // arrive as a message on the sign-in form. Without this the action throws
    // and the operator gets a blank 500 — the least diagnosable moment in the
    // whole console, because it is the one screen they can reach before
    // anything is known to work.
    console.error('[console] sign-in failed before the password was checked:', err);
    return failure(err);
  }

  if (!allowed || !result.ok) {
    if (result.ok === false && result.rateLimited) {
      return { ok: false, message: 'The auth service is rate-limiting sign-ins. Wait a minute and try again.' };
    }
    return { ok: false, message: 'That email address and password are not valid for this console.' };
  }

  clearRateLimit(`signin:${email}`);
  await createSession(email, result.authUserId);
  redirect('/');
}

export async function signOut(): Promise<void> {
  await destroySession();
  redirect('/login');
}
