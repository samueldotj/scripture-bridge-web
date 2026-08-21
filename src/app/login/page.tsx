'use client';

import { useActionState } from 'react';
import { signIn } from '@/app/actions/auth';
import { Notice, SubmitButton } from '@/components/form';
import type { ActionResult } from '@/lib/errors';

export default function LoginPage() {
  const [result, action] = useActionState<ActionResult | null, FormData>(signIn, null);

  return (
    <main className="login-wrap">
      <div className="login-card">
        <div className="card">
          <h1>Scripture Bridge Console</h1>
          <p className="sub">Coordinator sign-in.</p>

          <Notice result={result} />

          <form action={action} className="stack">
            <div className="field">
              <label htmlFor="email">Email</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <div>
              <SubmitButton pendingLabel="Checking…">Sign in</SubmitButton>
            </div>
          </form>
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 14, textAlign: 'center' }}>
          Console access is limited to the addresses listed in CONSOLE_OPERATORS.
        </p>
      </div>
    </main>
  );
}
