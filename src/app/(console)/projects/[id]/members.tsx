'use client';

import { useActionState } from 'react';
import { addMember } from '@/app/actions/projects';
import { Notice, SubmitButton } from '@/components/form';
import { Person } from '@/components/display';
import type { ActionResult } from '@/lib/errors';
import type { AccountRow, MemberRow } from '@/lib/queries';

const ROLES = ['translator', 'reviewer', 'admin'] as const;

/**
 * Membership, and the change-of-role path.
 *
 * `api.add_project_member` upserts, so adding an existing member with a
 * different role is how a role is changed — there is no separate operation, and
 * the RPC reports the previous role so the confirmation can say what actually
 * happened.
 *
 * There is deliberately no "remove member" control: no RPC exists for it, and
 * `app.project_member` references profiles with ON DELETE RESTRICT because a
 * removed member who still holds assignments would leave chapters assigned to
 * someone who can no longer read them. Reassign the chapters first; removal is
 * a database operation with a runbook, not a button.
 */
export function MembersCard({
  projectId,
  members,
  accounts,
}: {
  projectId: string;
  members: MemberRow[];
  accounts: AccountRow[];
}) {
  const [result, action] = useActionState<ActionResult | null, FormData>(addMember, null);

  // Anyone with an account can be added, including existing members — that is
  // the role-change path. Erased profiles are excluded: they have no account to
  // sign in with, so adding one would create an assignment nobody can act on.
  const candidates = accounts.filter((a) => !a.anonymised);

  return (
    <section className="card">
      <h2>Members</h2>
      <p className="hint">
        Only members can be assigned chapters. Adding someone who is already a member changes
        their role.
      </p>

      <Notice result={result} />

      {members.length === 0 ? (
        <p className="empty">Nobody has been added to this project yet.</p>
      ) : (
        <div className="table-scroll" style={{ marginBottom: 18 }}>
          <table>
            <thead>
              <tr>
                <th>Person</th>
                <th>Role</th>
                <th className="num">Assigned chapters</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr key={m.profile_id}>
                  <td>
                    <Person name={m.display_name} email={m.email} id={m.profile_id} />
                  </td>
                  <td>
                    <span className="badge">{m.role}</span>
                  </td>
                  <td className="num">{m.assigned_chapters}</td>
                  <td>
                    {m.anonymised ? (
                      <span className="badge flag">erased</span>
                    ) : m.must_change_password ? (
                      <span className="badge in_review">password change pending</span>
                    ) : (
                      <span className="muted">active</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <form action={action} className="row">
        <input type="hidden" name="project_id" value={projectId} />
        <div className="field">
          <label htmlFor="profile_id">Person</label>
          <select id="profile_id" name="profile_id" required defaultValue="">
            <option value="" disabled>
              Choose an account…
            </option>
            {candidates.map((a) => (
              <option key={a.profile_id} value={a.profile_id}>
                {a.display_name ?? a.email ?? a.profile_id}
                {a.email && a.display_name ? ` — ${a.email}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 170px' }}>
          <label htmlFor="role">Role</label>
          <select id="role" name="role" defaultValue="translator">
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: '0 0 auto' }}>
          <SubmitButton pendingLabel="Saving…">Add or update</SubmitButton>
        </div>
      </form>
    </section>
  );
}
