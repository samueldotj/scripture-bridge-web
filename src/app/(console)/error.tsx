'use client';

/**
 * The console's failure page.
 *
 * The two things that actually go wrong here are a missing environment
 * variable and an unreachable database, and both look identical in a generic
 * "something went wrong" screen. The message is shown verbatim because the
 * person reading it is an operator who can act on "connection refused" or
 * "DATABASE_URL is not set", and because none of these messages carry verse
 * text, a display name, or a token (DB R-ERR-4).
 */
export default function ConsoleError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const config = /is not set|must be at least 32|\.env/.test(error.message);

  return (
    <>
      <div className="page-head">
        <h1>{config ? 'Configuration problem' : 'That did not work'}</h1>
      </div>

      <div className="card">
        <p className="notice error" style={{ marginBottom: 16 }}>
          {error.message}
        </p>

        {config ? (
          <p className="muted" style={{ fontSize: 13.5 }}>
            The console reads its configuration from the environment at startup. Copy{' '}
            <code className="mono">.env.example</code> to <code className="mono">.env.local</code>,
            fill in every value, and restart.
          </p>
        ) : (
          <p className="muted" style={{ fontSize: 13.5 }}>
            If this mentions a connection, check that the Supabase stack is running and that{' '}
            <code className="mono">DATABASE_URL</code> points at it. Run{' '}
            <code className="mono">npm run check-stack</code> to test every dependency at once.
          </p>
        )}

        <div className="actions-row" style={{ marginTop: 16 }}>
          <button className="primary small" onClick={reset}>
            Try again
          </button>
        </div>

        {error.digest ? (
          <p className="muted mono" style={{ marginTop: 14, fontSize: 12 }}>
            digest {error.digest}
          </p>
        ) : null}
      </div>
    </>
  );
}
