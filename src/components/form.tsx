'use client';

import { useFormStatus } from 'react-dom';
import type { ActionResult } from '@/lib/errors';

/**
 * A submit button that disables itself while its form is in flight.
 *
 * Every form in this console performs a privileged, non-idempotent operation.
 * `create_project` materialises tens of thousands of rows and takes seconds; a
 * button that stays live during that invites the double-click that creates two
 * projects.
 */
export function SubmitButton({
  children,
  variant = 'primary',
  pendingLabel,
  confirm,
}: {
  children: React.ReactNode;
  variant?: 'primary' | 'danger' | 'plain';
  pendingLabel?: string;
  /** When set, the click must be confirmed. Used for irreversible actions. */
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  const className = variant === 'plain' ? 'small' : `${variant} small`;

  return (
    <button
      type="submit"
      className={className}
      disabled={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
    >
      {pending ? (pendingLabel ?? 'Working…') : children}
    </button>
  );
}

/** Renders the result of a Server Action, including the typed code when there is one. */
export function Notice({ result }: { result: ActionResult | null }) {
  if (!result) return null;
  return (
    <p className={`notice ${result.ok ? 'ok' : 'error'}`} role="status">
      {result.message}
      {!result.ok && result.code && result.code !== 'internal_error' ? (
        <>
          {' '}
          <code>{result.code}</code>
        </>
      ) : null}
    </p>
  );
}
