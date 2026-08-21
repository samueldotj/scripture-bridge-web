'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { callRpc } from '@/lib/db';
import { failure, success, type ActionResult } from '@/lib/errors';
import { requireSession, operatorLabel } from '@/lib/session';

/**
 * Project, membership, assignment, and reopen.
 *
 * Every one of these is a thin wrapper over an `api.*` function. None of them
 * validate what the function already validates, and none of them write an audit
 * row or a change-log entry themselves: those live inside the function (DB
 * migration 0015) precisely so the console and `provision.sh` cannot drift
 * apart on a rule. Re-checking here would create the second implementation that
 * migration set out to remove.
 *
 * What they do add is the operator label, which is the console's contribution
 * to the audit trail (DB R-AUTH-DB-12) — the database cannot know which
 * coordinator is at the keyboard, because the console authenticates its own
 * operators outside that schema.
 */

function trimmed(form: FormData, field: string): string {
  return String(form.get(field) ?? '').trim();
}

export async function createProject(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  let projectId: string;

  try {
    const session = await requireSession();

    const name = trimmed(form, 'name');
    const languageName = trimmed(form, 'language_name');
    const languageCode = trimmed(form, 'language_code');
    const scriptCode = trimmed(form, 'script_code');
    const scheme = trimmed(form, 'versification_scheme') || 'eng';
    const direction = trimmed(form, 'text_direction') || 'ltr';
    const books = form.getAll('books').map((b) => String(b));

    if (!name || !languageName || !languageCode || !scriptCode) {
      return { ok: false, message: 'Name, language, language code, and script code are all required.' };
    }
    // The RPC would accept an empty array and create a project with no content.
    // A project with no books is not a useful thing to have made by accident,
    // and the scheme is immutable afterwards (DB R-DATA-8), so it cannot be
    // fixed by editing — only by creating a second project.
    if (books.length === 0) {
      return { ok: false, message: 'Choose at least one book. The versification scheme cannot be changed afterwards.' };
    }

    const result = await callRpc<{ project_id: string; books_materialised: number }>(
      'api.create_project',
      [name, languageName, languageCode, scriptCode, scheme, direction, books, operatorLabel(session)],
    );
    projectId = result.project_id;
  } catch (err) {
    return failure(err);
  }

  revalidatePath('/projects');
  revalidatePath('/');
  redirect(`/projects/${projectId}`);
}

export async function addMember(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const projectId = trimmed(form, 'project_id');
    const profileId = trimmed(form, 'profile_id');
    const role = trimmed(form, 'role');

    if (!projectId || !profileId || !role) {
      return { ok: false, message: 'Choose a person and a role.' };
    }

    const result = await callRpc<{ role: string; previous_role: string | null }>(
      'api.add_project_member',
      [projectId, profileId, role, operatorLabel(session)],
    );

    revalidatePath(`/projects/${projectId}`);
    return success(
      result.previous_role && result.previous_role !== result.role
        ? `Role changed from ${result.previous_role} to ${result.role}.`
        : `Added as ${result.role}.`,
    );
  } catch (err) {
    return failure(err);
  }
}

/**
 * Assign or clear a chapter's translator and reviewer.
 *
 * The RPC takes both in one call and treats null as "unassigned", so the form
 * always submits both fields. Sending only the changed one would silently clear
 * the other — the kind of bug that surfaces as a reviewer wondering why their
 * queue emptied.
 */
export async function assignChapter(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const chapterId = trimmed(form, 'chapter_id');
    const projectId = trimmed(form, 'project_id');
    const translator = trimmed(form, 'translator_id') || null;
    const reviewer = trimmed(form, 'reviewer_id') || null;

    if (!chapterId) return { ok: false, message: 'No chapter was identified.' };

    await callRpc('api.assign_chapter', [
      chapterId,
      translator,
      reviewer,
      operatorLabel(session),
    ]);

    revalidatePath(`/projects/${projectId}`, 'layout');
    return success(
      translator || reviewer ? 'Assignment saved.' : 'Assignment cleared.',
    );
  } catch (err) {
    return failure(err);
  }
}

/**
 * Reopen an approved chapter (DB R-FN-14, APP §8.1).
 *
 * An approved chapter is read-only, so this is the only way back from an
 * approval made in error. It clears `approved_at`, `approved_by_id`, and
 * `submitted_at`, and the chapter returns to `in_progress` — the reviewer's
 * approval is undone, not amended, and the note is the only record of why.
 */
export async function reopenChapter(
  _prev: ActionResult | null,
  form: FormData,
): Promise<ActionResult> {
  try {
    const session = await requireSession();
    const chapterId = trimmed(form, 'chapter_id');
    const projectId = trimmed(form, 'project_id');
    const note = trimmed(form, 'note');

    if (!chapterId) return { ok: false, message: 'No chapter was identified.' };
    if (!note) {
      // The RPC accepts a null note. Requiring one here is a console policy: the
      // audit row is the only place the reason for undoing an approval is ever
      // written down, and "reopened by someone, at some point" is not an answer
      // to the question that gets asked six months later.
      return { ok: false, message: 'Give a reason. It is recorded in the audit log and nowhere else.' };
    }

    await callRpc('api.reopen_chapter', [chapterId, note, operatorLabel(session)]);

    revalidatePath(`/projects/${projectId}`, 'layout');
    return success('Chapter reopened and returned to in progress.');
  } catch (err) {
    return failure(err);
  }
}
