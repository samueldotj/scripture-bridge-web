import { listAccounts } from '@/lib/queries';
import { suggestPassword } from '@/lib/session';
import { AccountsView } from './view';

export default async function AccountsPage() {
  const accounts = await listAccounts();

  // Generated server-side, once per page load. A suggestion the operator can
  // accept beats a password they invent under time pressure, and this one never
  // leaves the console until they choose to use it.
  const suggestions = {
    create: suggestPassword(),
    reset: suggestPassword(),
  };

  return (
    <>
      <div className="page-head">
        <h1>Accounts</h1>
        <p>
          Self-registration is disabled and no recovery mail is ever sent, so every account is
          created here and every forgotten password is reset here. Identifiers may be synthetic
          addresses on a domain the project controls; they never need to receive mail.
        </p>
      </div>

      <AccountsView accounts={accounts} suggestions={suggestions} />
    </>
  );
}
