# scripture-bridge-web

Operations console for Scripture Bridge — the administrative surface for the Supabase backend
in [scripture-bridge-db](https://github.com/samueldotj/scripture-bridge-db).

**Status:** the administrative surface is built and verified against a live Supabase stack in
CI. One milestone criterion remains and is not automatable — see [Verification](#verification).

## Documentation

| Document | Contents |
|---|---|
| [docs/requirements.md](docs/requirements.md) | What the console must do: operations, operator identity, console-level policy, security, testing, scope |
| [docs/roadmap.md](docs/roadmap.md) | Where this repository enters the shared M0–M5 milestones, what M4 still owes, and the pilot gate |
| [docs/architecture.md](docs/architecture.md) | Why the shape was chosen, what was rejected, and the trade-offs behind the data path |

`docs/requirements.md` is authoritative on the requirement; `docs/architecture.md` is
authoritative on the reasoning. Both are companions to `scripture-bridge-db/docs/requirements.md`
(**DB**) and the app's requirements document (**APP**), which they cite rather than restate.

## Why this exists

The Android app has no administrative UI, deliberately. Project creation, account provisioning,
role and chapter assignment, password reset, and chapter reopen therefore exist nowhere else —
the database repository's roadmap lists this console as the third deliverable and the one thing
standing between the project and its pilot, because a coordinator must be able to provision an
account and an assignment without a developer.

Until now that work was done by `scripts/provision.sh` in the database repository, described
there as the console stand-in. This replaces it, calling the same `api.*` functions so the rules
have one implementation.

Password reset matters most. Self-service recovery is disabled and cannot work anyway —
identifiers may be synthetic addresses on a project-controlled domain that receive no mail — so
this console is the only thing between a translator and permanent lockout.

## What it does

| Screen | Operations |
|---|---|
| Overview | Fleet-wide counts, project progress, recent privileged actions |
| Projects | Create a project (books materialised from the versification scheme); per-project progress |
| Project detail | Add members and change roles; per-book progress |
| Book detail | Assign a chapter's translator and reviewer; reopen an approved chapter; export the book as USFM |
| Accounts | Create pre-confirmed accounts; reset a password and re-arm the forced change |
| Audit log | Every privileged operation, with operator and before/after values, filterable |

Not included: USFM **import**. DB R-USFM-2 requires the round-trip question settled first — a
source file's markers cannot be stored, so importing one would discard them silently. Export is
built and was never blocked by that decision (DB R-USFM-3).

## Running it

Requires Node 20+ and a running Scripture Bridge database — the local Supabase stack from the
database repository is enough:

```bash
cd ../scripture-bridge-db && supabase start
```

Then:

```bash
npm install
```

```bash
cp .env.example .env.local
```

Fill in `.env.local` — `supabase status` prints the URL and both keys — then confirm every
dependency is actually present:

```bash
npm run check-stack
```

That checks the Postgres version, the schemas, each `api.*` function the console calls, whether
any versification scheme is seeded, that the admin API accepts the service key, and that
self-registration is disabled. It writes nothing and never prints the service key.

```bash
npm run dev
```

### Pointing at a hosted Supabase project

Two things differ from the local stack, and both are TLS:

- **Set `DATABASE_CA_CERT`.** A hosted project's certificate chain is not in Node's default CA
  store, so a verified connection fails with *self-signed certificate in certificate chain*.
  Download the certificate from Settings → Database → SSL Configuration and point this at it.
- **Do not append `?sslmode=require`.** This driver verifies the chain on `require`, unlike
  libpq where it means encrypt-without-verifying, so it fails identically. `?sslmode=no-verify`
  works and is the deliberate opt-out — encrypted, but unauthenticated.

Use the pooler connection string rather than the direct one, which is IPv6-only.

### Operator accounts

An operator is an ordinary auth user whose email also appears in `CONSOLE_OPERATORS`. Create one
the same way any account is created — through the admin API, or `provision.sh create-user` in the
database repository — then add the address to `CONSOLE_OPERATORS` and restart.

The console verifies the password against GoTrue once at sign-in and then issues its own signed,
httpOnly session cookie. It never reads project data with an operator's JWT: a coordinator is not
a member of the projects they administer, and RLS would correctly show them nothing.

**If an operator cannot sign in**, they are locked out of the tool that resets passwords — the
console's reset is for other people and requires being signed in. That bootstrap gap is what this
is for:

```bash
npm run reset-operator
```

It prompts twice without echoing, refuses a password given as an argument (shell history), and
writes an audit row. Add `-- --dry-run` to rehearse it without changing anything.

It **will not reset a translator**: only addresses in `CONSOLE_OPERATORS` are accepted. A
translator's reset belongs in the console, which also re-arms their forced password change — a
script that skipped that would leave them signed in on a password a coordinator knows, with no
change pending.

## Security shape

- **The service key never leaves the server.** No `NEXT_PUBLIC_*` variable exists in this
  project; the browser talks only to this app. Every module that touches a credential imports
  `server-only`, so importing one from a Client Component is a build error rather than a leak.
- **Authorisation is checked where the write happens.** The layout guard protects rendering;
  each Server Action re-checks the session itself, because an action reached directly does not
  pass through a layout.
- **The allowlist is re-checked per request**, not just at sign-in.
- **Sign-ins are rate-limited** per address, in front of GoTrue's own limits.
- **Nothing is cached.** Every page is `force-dynamic` and sends `no-store`: a stale render is
  how two coordinators assign the same chapter to two people.

## Verification

| Command | Checks |
|---|---|
| `npm run check` | Typecheck, unit tests, build, client bundle, schema guard — everything that needs no database |
| `npm test` | Unit tests for the USFM generator and the Postgres TLS decision |
| `npm run check-stack` | Preflight against a live stack: version, schemas, functions, seeded data, admin API, auth settings |
| `npm run verify-e2e` | The full M4 sequence — provision, assign, reopen, reset — asserting audit and change-log outcomes |

Two of these are worth explaining.

**`check-schema`** parses the migrations in `scripture-bridge-db` and resolves every table,
column, and function signature this console's SQL references. The console composes SQL in
template literals, which TypeScript cannot check, so without it a renamed column becomes a
runtime error found by a coordinator. Point it at a checkout with `SB_DB_REPO=...`; CI checks
that repository out so the guard always has something to compare against.

**`verify-e2e`** writes real data and does not clean up, so it refuses to run outside CI without
`-- --i-know-this-writes`. Run it against a disposable stack.

All of it runs on push — see [.github/workflows/web.yml](.github/workflows/web.yml), whose `e2e`
job starts a full Supabase stack, since Docker and the Supabase CLI live in CI rather than on a
developer's machine.

The e2e job is green: 54 assertions covering provisioning, project materialisation, membership,
assignment, reopen, password reset, USFM export, the audit trail, and the console's own HTTP
surface. The
load-bearing one is that assignment writes a change-log entry — the defect DB migration 0015 was
written to fix, confirmed here by its first caller outside pgTAP.

**One thing it cannot prove.** That a chapter assigned through the console actually arrives on a
device. The verification asserts the change-log entry exists; delta sync delivering it to a
signed-in app client needs a device, a translator, and a person watching.

One thing `check-stack` will report as a warning: `service_role` has no `USAGE` on schema `api`. That is
expected on a stock stack and does not affect this console, which uses a direct connection. It
does mean the console RPCs are unreachable over PostgREST as `service_role` today —
see [docs/architecture.md](docs/architecture.md), which also carries the migration that would fix
it if the HTTP path is ever wanted.

## Layout

```
src/lib/         server-only: config, connection, GoTrue admin, error model, queries, session
src/app/actions/ Server Actions — every privileged write, one per api.* function
src/app/         routes; (console) is the authenticated group
scripts/         preflight, bundle check, schema guard, M4 verification, CI wrapper
docs/            requirements, roadmap, architecture
.github/         CI: checks on every push, M4 verification against a live stack
```

## License

See [LICENSE](LICENSE).
