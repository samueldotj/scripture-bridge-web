'use client';

import { useActionState, useState } from 'react';
import { assignChapter, reopenChapter } from '@/app/actions/projects';
import { Notice, SubmitButton } from '@/components/form';
import { Progress, StateBadge, Timestamp } from '@/components/display';
import type { ActionResult } from '@/lib/errors';
import type { ChapterRow, MemberRow } from '@/lib/queries';

export function ChapterTable({
  projectId,
  chapters,
  translators,
  reviewers,
}: {
  projectId: string;
  chapters: ChapterRow[];
  translators: MemberRow[];
  reviewers: MemberRow[];
}) {
  const [open, setOpen] = useState<string | null>(null);

  return (
    <div className="card">
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th className="num">Ch.</th>
              <th>State</th>
              <th>Translator</th>
              <th>Reviewer</th>
              <th>Verses done</th>
              <th className="num">Flagged</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {chapters.map((c) => (
              <ChapterRows
                key={c.id}
                projectId={projectId}
                chapter={c}
                translators={translators}
                reviewers={reviewers}
                expanded={open === c.id}
                onToggle={() => setOpen((cur) => (cur === c.id ? null : c.id))}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ChapterRows({
  projectId,
  chapter,
  translators,
  reviewers,
  expanded,
  onToggle,
}: {
  projectId: string;
  chapter: ChapterRow;
  translators: MemberRow[];
  reviewers: MemberRow[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        <td className="num">{chapter.number}</td>
        <td>
          <StateBadge state={chapter.workflow_state} />
        </td>
        <td>
          {chapter.assigned_translator_name ?? <span className="muted">unassigned</span>}
        </td>
        <td>{chapter.assigned_reviewer_name ?? <span className="muted">—</span>}</td>
        <td>
          <Progress done={chapter.verses_done} total={chapter.verse_count} />
        </td>
        <td className="num">
          {chapter.verses_flagged > 0 ? (
            <span className="badge flag">{chapter.verses_flagged}</span>
          ) : (
            <span className="muted">0</span>
          )}
        </td>
        <td className="nowrap">
          <button type="button" className="link" onClick={onToggle} aria-expanded={expanded}>
            {expanded ? 'Close' : 'Manage'}
          </button>
        </td>
      </tr>

      {expanded ? (
        <tr>
          <td colSpan={7} style={{ background: 'var(--surface-2)' }}>
            <ChapterEditor
              projectId={projectId}
              chapter={chapter}
              translators={translators}
              reviewers={reviewers}
            />
          </td>
        </tr>
      ) : null}
    </>
  );
}

function ChapterEditor({
  projectId,
  chapter,
  translators,
  reviewers,
}: {
  projectId: string;
  chapter: ChapterRow;
  translators: MemberRow[];
  reviewers: MemberRow[];
}) {
  const [assignResult, assign] = useActionState<ActionResult | null, FormData>(
    assignChapter,
    null,
  );
  const [reopenResult, reopen] = useActionState<ActionResult | null, FormData>(
    reopenChapter,
    null,
  );

  return (
    <div style={{ padding: '6px 0 10px' }}>
      <Notice result={assignResult} />

      {/*
        Both assignees are always submitted, even the unchanged one: the RPC
        takes the pair and treats a missing value as "unassigned", so posting
        only the edited field would quietly clear the other.
      */}
      <form action={assign} className="row">
        <input type="hidden" name="chapter_id" value={chapter.id} />
        <input type="hidden" name="project_id" value={projectId} />

        <div className="field">
          <label htmlFor={`t-${chapter.id}`}>Translator</label>
          <select
            id={`t-${chapter.id}`}
            name="translator_id"
            defaultValue={chapter.assigned_translator_id ?? ''}
          >
            <option value="">Unassigned</option>
            {translators.map((m) => (
              <option key={m.profile_id} value={m.profile_id}>
                {m.display_name ?? m.email ?? m.profile_id} ({m.role})
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor={`r-${chapter.id}`}>Reviewer</label>
          <select
            id={`r-${chapter.id}`}
            name="reviewer_id"
            defaultValue={chapter.assigned_reviewer_id ?? ''}
          >
            <option value="">Unassigned</option>
            {reviewers.map((m) => (
              <option key={m.profile_id} value={m.profile_id}>
                {m.display_name ?? m.email ?? m.profile_id} ({m.role})
              </option>
            ))}
          </select>
        </div>

        <div className="field" style={{ flex: '0 0 auto' }}>
          <SubmitButton pendingLabel="Saving…">Save assignment</SubmitButton>
        </div>
      </form>

      <p className="muted" style={{ fontSize: 12.5, marginTop: 8, marginBottom: 0 }}>
        Saving writes a change-log entry, which is how the assignment reaches the translator&apos;s
        device — the app learns of it through delta sync and no other way.
      </p>

      {chapter.workflow_state === 'approved' ? (
        <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <Notice result={reopenResult} />
          <p style={{ fontSize: 13.5, margin: '0 0 10px' }}>
            <strong>Reopen this chapter.</strong>{' '}
            <span className="muted">
              Approved on <Timestamp value={chapter.approved_at} />. Reopening returns it to
              &ldquo;in progress&rdquo; and discards the approval and submission timestamps. It is
              the only way back from an approval made in error.
            </span>
          </p>
          <form action={reopen} className="row">
            <input type="hidden" name="chapter_id" value={chapter.id} />
            <input type="hidden" name="project_id" value={projectId} />
            <div className="field">
              <label htmlFor={`n-${chapter.id}`}>Reason</label>
              <input
                id={`n-${chapter.id}`}
                name="note"
                type="text"
                required
                placeholder="Why this approval is being undone"
              />
              <span className="help">Recorded in the audit log, and nowhere else.</span>
            </div>
            <div className="field" style={{ flex: '0 0 auto' }}>
              <SubmitButton
                variant="danger"
                pendingLabel="Reopening…"
                confirm={`Reopen chapter ${chapter.number}? The approval will be discarded.`}
              >
                Reopen chapter
              </SubmitButton>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  );
}
