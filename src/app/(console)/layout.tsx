import { redirect } from 'next/navigation';
import Link from 'next/link';
import { getSession } from '@/lib/session';
import { signOut } from '@/app/actions/auth';

/**
 * Route segment config, inherited by every page under this layout and by the
 * Server Actions those pages invoke.
 *
 * `create_project` materialises every verse of every book it is given — about
 * 31,000 rows for a whole Bible — and the pool allows the statement 120 seconds
 * (lib/db). A serverless host's default function timeout is shorter than that,
 * and a project half-materialised when the function is killed is the failure
 * WEB R-OPS-WEB-8 exists to prevent. 300 seconds is the ceiling every Vercel
 * plan allows, so the statement timeout stays the binding limit. Harmless on a
 * long-lived instance, which imposes no ceiling of its own.
 */
export const maxDuration = 300;

/**
 * The authorisation gate for every console page.
 *
 * A layout guard protects rendering, not writing — a Server Action reached
 * directly does not pass through here, which is why `requireSession()` is
 * repeated inside each one.
 */
export default async function ConsoleLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getSession();
  if (!session) redirect('/login');

  return (
    <div className="shell">
      <nav className="sidebar">
        <div className="brand">
          <div className="brand-name">Scripture Bridge</div>
          <div className="brand-sub">Operations console</div>
        </div>

        <Link className="nav-link" href="/">
          Overview
        </Link>
        <Link className="nav-link" href="/projects">
          Projects
        </Link>
        <Link className="nav-link" href="/accounts">
          Accounts
        </Link>
        <Link className="nav-link" href="/audit">
          Audit log
        </Link>

        <div className="sidebar-foot">
          <div className="who">{session.email}</div>
          <form action={signOut}>
            <button type="submit" className="link">
              Sign out
            </button>
          </form>
        </div>
      </nav>

      <main className="main">{children}</main>
    </div>
  );
}
