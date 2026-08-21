# Console architecture

**Companion:** `scripture-bridge-db/docs/requirements.md` (**DB**) and its `docs/roadmap.md`.

This document records the decisions that are not obvious from the code, and the one finding in
the database repository that the console had to work around.

---

## 1. Shape

One Next.js application. Server Components read, Server Actions write, and the browser holds
nothing but a session cookie.

The roadmap's constraint is that the console needs a server-side component to hold the service
key: a pure client-side console is not a deliverable shape, because the service key bypasses RLS
entirely and its exposure is a full compromise of every project's data (DB R-RLS-3). A single
Next.js deployable satisfies that with no second tier to secure — there is no browser-reachable
API in this project at all, only Server Actions, which are POST endpoints scoped to a form and
origin-checked by the framework.

There is deliberately no `NEXT_PUBLIC_*` variable. The browser has no legitimate need for a
Supabase credential of any kind here.

---

## 2. How the console reaches the database

**Decision: a direct Postgres connection for data, the GoTrue admin API for accounts.**

This is the same split `scripture-bridge-db/scripts/provision.sh` uses, and it is not the shape
the database repository's grants imply. That deserves an explanation.

### What migration 0015 implies

`20260811000015_console_api.sql` ends by revoking each console function from `public` and
`authenticated` and granting it to `service_role`. A grant to `service_role` only means anything
over PostgREST — it is the role PostgREST assumes when a request carries the service key. So the
migration's intent is clearly that the console calls `POST /rest/v1/rpc/create_project` and so
on.

### Why that does not work today

**`service_role` is never granted `USAGE` on schema `api`.** Supabase's stock role setup grants
schema usage for `public` only; migration `0001_schemas.sql` grants `api`, `app`, and `ref` to
`authenticated` alone. Executing a function requires `USAGE` on its schema regardless of the
`EXECUTE` grant, so every console RPC — and `api.anonymise_profile`, granted the same way in the
erasure migration — returns *permission denied for schema api* when called as `service_role`.

Nothing in that repository exercises the path: the pgTAP tests run as `postgres`, and
`provision.sh` uses `psql`. `smoke-http.sh` covers the app's surface as `authenticated` and never
calls a console function. So the gap is real but invisible there.

**Three read surfaces are not exposed at all.** Project members, the audit log, and the book
canon live in `app` and `ref`, which PostgREST cannot reach by design (DB R-SCHEMA-2), and no
`api` view or RPC covers them. A console that could only use PostgREST could not show its own
audit trail.

### The consequence

A PostgREST console needs a migration in the database repository. A direct-connection console
needs nothing, works today, and reads whatever it needs. Since `provision.sh` — the roadmap's
designated stand-in for exactly this tool — already resolves it the same way, the console
follows it.

**Every write still goes through the `api.*` functions.** No validation, no change-log entry,
and no audit row is reimplemented here. That was migration 0015's whole purpose: assignment
through raw SQL wrote no change-log entry, so a chapter assigned by a coordinator never reached
the translator's device. Duplicating any of that logic in TypeScript would recreate the second
implementation the migration removed. See `src/app/actions/projects.ts`.

### If the HTTP path is wanted later

It needs one migration in `scripture-bridge-db`. Sketched, not applied — it belongs in that
repository, on its migration timeline, with its CI guards run against it:

```sql
-- Console access for the service key.
--
-- EXECUTE without USAGE on the schema is inert: every function granted to
-- service_role in 0015 and 0012 is unreachable over PostgREST without this.
grant usage on schema api to service_role;
grant select on all tables in schema api to service_role;

-- Reads PostgREST cannot serve because they live outside `api`. SECURITY
-- DEFINER rather than views, because a security_invoker view over auth.users
-- fails for service_role, which holds no grant there.
--
-- NOTE for whoever writes these: `alter default privileges in schema api grant
-- select on tables to authenticated` in 0001 applies to VIEWS as well as
-- tables. Any new object in `api` is granted to `authenticated` automatically
-- and must be revoked explicitly, or the console's view of every project's
-- membership becomes readable by every signed-in translator.
```

Then `src/lib/db.ts` is the only file that changes.

### What the direct connection costs

The connecting role bypasses RLS. That is correct here and nowhere else: a coordinator
provisioning a cohort is not a member of the projects they administer, and RLS would show them
nothing. It does mean the console is trusted infrastructure — which it already was, holding the
service key.

It also requires network reach to Postgres, not just to the API. On a hosted project use the
pooler connection string; a console holding a handful of long-lived connections is what the
pooler is for.

---

## 3. Operator identity

Migration 0015 says it plainly: the console authenticates its own operators outside the database
schema and passes a label, because `actor_kind = 'console'` with a null profile records that *a
console* did something and not *which coordinator*.

An operator is an ordinary auth user whose address also appears in `CONSOLE_OPERATORS`. Their
password is verified against GoTrue once, then discarded:

- The console never reads project data with an operator's JWT. RLS would filter a non-member to
  nothing, which is the correct behaviour and the wrong tool for this job.
- Holding a refresh token for a privileged human is a liability with no compensating benefit.

What the session cookie carries instead is an HMAC-signed assertion of who is at the keyboard,
which becomes `p_operator` on every `api.*` call — `<email>@console`, mirroring
`provision.sh`'s `<user>@provision.sh` so an audit reader can tell the two apart.

The allowlist is re-checked on every request rather than only at sign-in, so removing an operator
takes effect on their next click.

**Rejected: a separate credential store** (operator emails and bcrypt hashes in the environment).
It removes the GoTrue dependency from sign-in and adds a second set of passwords to manage,
rotate, and lose. Given that account provisioning already requires the admin API, the dependency
is not avoidable in any useful sense.

---

## 4. Console policies not present in the database

Three rules are enforced here and not in the schema. Each is a console policy, and each is worth
knowing about because the database will happily accept what the console refuses:

| Rule | Where | Why not in the database |
|---|---|---|
| A reopen requires a written reason | `actions/projects.ts` | `api.reopen_chapter` accepts a null note. The audit row is the only record of why an approval was undone, and "reopened by someone, at some point" is not an answer to the question asked six months later. |
| A new project must have at least one book | `actions/projects.ts` | The RPC accepts an empty array. The scheme is immutable afterwards (DB R-DATA-8), so an empty project cannot be fixed by editing — only by creating a second one. |
| Initial passwords are at least 12 characters | `actions/accounts.ts` | GoTrue's default floor is six. This password is spoken over a phone line and lives until a forced change that may be days away. |

Everything else — role values, membership before assignment, workflow transitions, versification
validity — is refused by the function, surfaced by `lib/errors.ts`, and not second-guessed here.

---

## 5. The two-step password reset

Resetting someone's password is an HTTP call to GoTrue followed by a database call, and they
cannot be one transaction.

The second step is not optional. `api.rearm_password_change` re-sets `must_change_password` *and*
re-fingerprints the new hash, so that `complete_password_change` later compares against the right
one (DB R-AUTH-DB-7). The admin API alone leaves a translator able to sign in with a password a
coordinator knows and no forced change pending — the exact situation the flag exists to prevent.

So when the first step succeeds and the second fails, the console says so explicitly and tells
the operator to run the reset again. It does not report success, and it does not silently retry:
an operator who believes a reset completed will hand over the password and move on.

---

## 6. Deliberate omissions

- **Removing a project member.** No RPC exists, and `app.project_member` references profiles with
  `ON DELETE RESTRICT`. A removed member holding assignments leaves chapters assigned to someone
  who can no longer read them. Reassign first; removal is a runbook, not a button.
- **USFM import and export.** M5 work with no contract in the database repository yet.
- **Anonymising a profile.** `api.anonymise_profile` exists and is irreversible by design. It is
  a legal process with a decision behind it, and putting it one click from the account list
  invites the mistake it cannot recover from.
- **Editing verse text.** The console can see progress but not content. Translation is the app's
  job, and a coordinator editing verses through a service-key connection would bypass the
  revision-capture policy that makes history trustworthy.
