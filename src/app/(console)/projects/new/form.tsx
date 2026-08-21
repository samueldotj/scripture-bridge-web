'use client';

import { useActionState, useMemo, useState } from 'react';
import { createProject } from '@/app/actions/projects';
import { Notice, SubmitButton } from '@/components/form';
import type { ActionResult } from '@/lib/errors';
import type { CanonBookRow, SchemeRow } from '@/lib/queries';

export function NewProjectForm({
  schemes,
  canonByScheme,
  defaultScheme,
}: {
  schemes: SchemeRow[];
  canonByScheme: Record<string, CanonBookRow[]>;
  defaultScheme: string;
}) {
  const [result, action] = useActionState<ActionResult | null, FormData>(createProject, null);
  const [scheme, setScheme] = useState(defaultScheme);
  const [selected, setSelected] = useState<Set<string>>(new Set(['MAT']));

  const canon = useMemo(() => canonByScheme[scheme] ?? [], [canonByScheme, scheme]);

  // Materialisation cost, shown before the button is pressed. A whole-Bible
  // project writes ~31,000 verse rows and takes noticeably longer than one
  // gospel; an operator who knows that will not assume the console has hung.
  const verseTotal = useMemo(
    () => canon.filter((b) => selected.has(b.code)).reduce((sum, b) => sum + b.verse_count, 0),
    [canon, selected],
  );

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  function selectGroup(codes: string[]) {
    setSelected(new Set(codes));
  }

  const nt = canon.filter((b) => b.testament === 'nt').map((b) => b.code);
  const ot = canon.filter((b) => b.testament === 'ot').map((b) => b.code);

  return (
    <form action={action} className="stack">
      <Notice result={result} />

      <div className="card">
        <h2>Identity</h2>
        <div className="row">
          <div className="field">
            <label htmlFor="name">Project name</label>
            <input id="name" name="name" type="text" required />
          </div>
          <div className="field">
            <label htmlFor="language_name">Language name</label>
            <input id="language_name" name="language_name" type="text" required />
          </div>
        </div>

        <div className="row" style={{ marginTop: 14 }}>
          <div className="field">
            <label htmlFor="language_code">Language code</label>
            <input id="language_code" name="language_code" type="text" required placeholder="ta" />
            <span className="help">
              BCP 47. Not validated beyond shape — rejecting a real language is worse than
              accepting an unusual tag.
            </span>
          </div>
          <div className="field">
            <label htmlFor="script_code">Script code</label>
            <input id="script_code" name="script_code" type="text" required placeholder="Taml" />
            <span className="help">ISO 15924, e.g. Latn, Taml, Deva, Arab.</span>
          </div>
          <div className="field">
            <label htmlFor="text_direction">Text direction</label>
            <select id="text_direction" name="text_direction" defaultValue="ltr">
              <option value="ltr">Left to right</option>
              <option value="rtl">Right to left</option>
            </select>
          </div>
        </div>
      </div>

      <div className="card">
        <h2>Versification</h2>
        <p className="hint">
          Permanent. It determines the verse count of every chapter, and changing it later would
          orphan or duplicate verse rows that already hold translated text.
        </p>
        <div className="field" style={{ maxWidth: 320 }}>
          <label htmlFor="versification_scheme">Scheme</label>
          <select
            id="versification_scheme"
            name="versification_scheme"
            value={scheme}
            onChange={(e) => {
              setScheme(e.target.value);
              setSelected(new Set(['MAT']));
            }}
          >
            {schemes.map((s) => (
              <option key={s.code} value={s.code} disabled={!s.usable}>
                {s.name} ({s.code}){s.usable ? '' : ' — no data seeded'}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card">
        <h2>Books</h2>
        <p className="hint">
          Each book selected is materialised in full: every chapter, and one empty verse row per
          verse. Books can be added to a project later; they cannot be removed once they hold text.
        </p>

        <div className="actions-row" style={{ marginBottom: 12 }}>
          <button type="button" className="small" onClick={() => selectGroup(['MAT'])}>
            Matthew only
          </button>
          <button type="button" className="small" onClick={() => selectGroup(nt)}>
            New Testament
          </button>
          <button type="button" className="small" onClick={() => selectGroup(ot)}>
            Old Testament
          </button>
          <button type="button" className="small" onClick={() => selectGroup(canon.map((b) => b.code))}>
            Whole Bible
          </button>
          <button type="button" className="small" onClick={() => selectGroup([])}>
            Clear
          </button>
          <span className="muted" style={{ fontSize: 13, marginLeft: 'auto' }}>
            {selected.size} book{selected.size === 1 ? '' : 's'} · {verseTotal.toLocaleString()}{' '}
            verse rows
          </span>
        </div>

        <fieldset>
          <legend>Canon</legend>
          <div className="checks">
            {canon.map((b) => (
              <label className="check" key={b.code}>
                <input
                  type="checkbox"
                  name="books"
                  value={b.code}
                  checked={selected.has(b.code)}
                  onChange={() => toggle(b.code)}
                />
                <span>{b.name_en}</span>
                <span className="count">{b.chapter_count}ch</span>
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="actions-row">
        <SubmitButton pendingLabel="Materialising…">Create project</SubmitButton>
        <span className="muted" style={{ fontSize: 13 }}>
          {verseTotal > 5000
            ? 'This will write tens of thousands of rows and may take a minute.'
            : null}
        </span>
      </div>
    </form>
  );
}
