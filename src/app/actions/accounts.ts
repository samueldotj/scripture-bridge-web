'use server';

import { revalidatePath } from 'next/cache';
import { callRpc, query } from '@/lib/db';
import { createAuthUser, setUserPassword } from '@/lib/gotrue';
import { failure, success, ConsoleError, type ActionResult } from '@/lib/errors';
import { profileForAuthUser } from '@/lib/queries';
import { requireSession, operatorLabel } from '@/lib/session';

/**
 * Account provisioning and password reset.
 *
 * These are the two operations the pilot cannot happen without: nobody can sign
 * in until a coordinator creates their account, and nobody can recover from a
 * forgotten password without a coordinator resetting it. Self-service recovery
 * is deliberately disabled and cannot work anyway — identifiers may be
 * synthetic addresses on a project-controlled domain that receive no mail
 * (APP R-AUTH-2, R-AUTH-7).
 */

/**
 * The console's floor for an initial password.
 *
 * Higher than GoTrue's default of six. This password is communicated out of
 * band — spoken over a phone line, written on paper — and lives until the
 * translator completes their forced change, which may be days later on a
 * device that has not yet been online.
 */
const MIN_PASSWORD_LENGTH = 12;

function trimmed(form: FormData, field: string): string {
  return String(form.get(field) ?? '').trim();
}

export async function createAccount(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const displayName = trimmed(form, 'display_name');
    const email = trimmed(form, 'email').toLowerCase();
    const password = String(form.get('password') ?? '');

    if (!displayName || !email) {
      return { ok: false, message: 'A display name and an email address are both required.' };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return {
        ok: false,
        message: `The initial password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      };
    }

    const { id: authUserId } = await createAuthUser(email, password, displayName);

    // The profile arrives by trigger (DB R-AUTH-DB-6). If it did not, the
    // account can sign in but is invisible to every query in the schema — a
    // failure that presents to the translator as an app with no data, so it is
    // reported here rather than left to be discovered in the field.
    const profile = await profileForAuthUser(authUserId);
    if (!profile) {
      throw new ConsoleError({
        code: 'profile_missing',
        status: 500,
        details: null,
        message:
          `The account for ${email} was created but no profile row appeared. ` +
          'The trigger on auth.users is missing or failed — this account will be invisible to the app.',
      });
    }

    // `must_change_password` is left at its default of true: the initial
    // password is known to at least two people by construction, and RLS blocks
    // all project content until the translator changes it (R-AUTH-DB-8).
    await query(
      `select app.console_audit($1, $2, $3::uuid, $4, null::jsonb, $5::jsonb)`,
      ['profile.create', 'profile', profile.id, operatorLabel(session), JSON.stringify({ email })],
    );

    revalidatePath('/accounts');
    revalidatePath('/');
    return success(
      `Account created for ${email}. They must change this password at first sign-in before any project data is readable.`,
    );
  } catch (err) {
    return failure(err);
  }
}

/**
 * Sets someone else's password and re-arms the forced change.
 *
 * Two steps that must both happen. The admin API sets the password; only
 * `api.rearm_password_change` re-sets `must_change_password` AND re-fingerprints
 * the new hash, so that `complete_password_change` later compares against the
 * right one (DB R-AUTH-DB-7). Doing the first without the second leaves a
 * translator signed in on a password a coordinator knows, with no forced
 * change pending — which is the situation the flag exists to prevent.
 *
 * They are not atomic: the password change is an HTTP call to GoTrue and
 * cannot join the database transaction. If the second step fails the operator
 * is told exactly that, because the recovery is to run the reset again rather
 * than to assume it worked.
 */
export async function resetPassword(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const profileId = trimmed(form, 'profile_id');
    const authUserId = trimmed(form, 'auth_user_id');
    const password = String(form.get('password') ?? '');

    if (!profileId || !authUserId) {
      // An erased profile has no auth user to reset (DB R-DATA-4).
      return { ok: false, message: 'That profile has no account attached; there is no password to reset.' };
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return {
        ok: false,
        message: `The new password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
      };
    }

    await setUserPassword(authUserId, password);

    try {
      await callRpc('api.rearm_password_change', [profileId, operatorLabel(session)]);
    } catch (err) {
      const inner = failure(err);
      return {
        ok: false,
        code: inner.code,
        message:
          'The password was changed, but the forced-change flag was NOT re-armed: ' +
          `${inner.message} Run the reset again — until it succeeds, this account can be used ` +
          'with the password you just set and will not be asked to change it.',
      };
    }

    revalidatePath('/accounts');
    revalidatePath('/');
    return success('Password reset. They must change it at next sign-in.');
  } catch (err) {
    return failure(err);
  }
}
