'use client';

import { useActionState, useState } from 'react';
import { createAccount, resetPassword } from '@/app/actions/accounts';
import { Notice, SubmitButton } from '@/components/form';
import { Person, Timestamp } from '@/components/display';
import type { ActionResult } from '@/lib/errors';
import type { AccountRow } from '@/lib/queries';

export function AccountsView({
  accounts,
  suggestions,
}: {
  accounts: AccountRow[];
  suggestions: { create: string; reset: string };
}) {
  const [resetting, setResetting] = useState<string | null>(null);

  return (
    <>
      <CreateAccountCard suggestion={suggestions.create} />

      <section className="card">
        <h2>Existing accounts</h2>
        <p className="hint">
          &ldquo;Password change pending&rdquo; means the account cannot read any project data yet.
          The gate is enforced in the database, not in the app&apos;s navigation, so it holds even
          against a modified client.
        </p>

        {accounts.length === 0 ? (
          <p className="empty">No accounts yet.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Person</th>
                  <th>Status</th>
                  <th className="num">Projects</th>
                  <th>Last sign-in</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <RowGroup
                    key={a.profile_id}
                    account={a}
                    suggestion={suggestions.reset}
                    open={resetting === a.profile_id}
                    onToggle={() =>
                      setResetting((cur) => (cur === a.profile_id ? null : a.profile_id))
                    }
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function CreateAccountCard({ suggestion }: { suggestion: string }) {
  const [result, action] = useActionState<ActionResult | null, FormData>(createAccount, null);

  return (
    <section className="card">
      <h2>Create an account</h2>
      <p className="hint">
        The account is created pre-confirmed, with the forced password change armed. Give the
        person the initial password out of band — it is known to both of you, which is exactly why
        the app makes them change it before showing any project content.
      </p>

      <Notice result={result} />

      <form action={action} className="row">
        <div className="field">
          <label htmlFor="display_name">Display name</label>
          <input id="display_name" name="display_name" type="text" required />
        </div>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" name="email" type="email" required autoComplete="off" />
          <span className="help">May be synthetic; no mail is sent to it.</span>
        </div>
        <div className="field">
          <label htmlFor="password">Initial password</label>
          <input
            id="password"
            name="password"
            type="text"
            required
            minLength={12}
            defaultValue={suggestion}
            autoComplete="off"
            className="mono"
          />
          <span className="help">Shown, not hidden — you have to be able to read it out.</span>
        </div>
        <div className="field" style={{ flex: '0 0 auto' }}>
          <SubmitButton pendingLabel="Creating…">Create account</SubmitButton>
        </div>
      </form>
    </section>
  );
}

function RowGroup({
  account,
  suggestion,
  open,
  onToggle,
}: {
  account: AccountRow;
  suggestion: string;
  open: boolean;
  onToggle: () => void;
}) {
  const [result, action] = useActionState<ActionResult | null, FormData>(resetPassword, null);

  return (
    <>
      <tr>
        <td>
          <Person name={account.display_name} email={account.email} id={account.profile_id} />
        </td>
        <td>
          {account.anonymised ? (
            <span className="badge flag">erased</span>
          ) : account.must_change_password ? (
            <span className="badge in_review">password change pending</span>
          ) : (
            <span className="muted">active</span>
          )}
        </td>
        <td className="num">{account.project_count}</td>
        <td>
          <Timestamp value={account.last_sign_in_at} />
        </td>
        <td className="nowrap">
          {account.anonymised || !account.auth_user_id ? (
            <span className="muted" style={{ fontSize: 13 }}>
              no account
            </span>
          ) : (
            <button type="button" className="link" onClick={onToggle} aria-expanded={open}>
              {open ? 'Cancel' : 'Reset password'}
            </button>
          )}
        </td>
      </tr>

      {open && account.auth_user_id ? (
        <tr>
          <td colSpan={5} style={{ background: 'var(--surface-2)' }}>
            <div style={{ padding: '6px 0 10px' }}>
              <Notice result={result} />
              <form action={action} className="row">
                <input type="hidden" name="profile_id" value={account.profile_id} />
                <input type="hidden" name="auth_user_id" value={account.auth_user_id} />
                <div className="field">
                  <label htmlFor={`pw-${account.profile_id}`}>New password</label>
                  <input
                    id={`pw-${account.profile_id}`}
                    name="password"
                    type="text"
                    required
                    minLength={12}
                    defaultValue={suggestion}
                    autoComplete="off"
                    className="mono"
                  />
                  <span className="help">
                    They will be required to change it again at next sign-in.
                  </span>
                </div>
                <div className="field" style={{ flex: '0 0 auto' }}>
                  <SubmitButton
                    pendingLabel="Resetting…"
                    confirm={`Reset the password for ${account.email ?? account.display_name ?? 'this account'}?`}
                  >
                    Reset password
                  </SubmitButton>
                </div>
              </form>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
