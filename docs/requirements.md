# Scripture Bridge — Web Console Requirements

**Status:** Draft — §6 verified against a live stack in CI as of 2026-08-20
**Scope:** The administrative console for the Scripture Bridge backend
**Companion documents:** `scripture-bridge-db/docs/requirements.md` (**DB**) and
`scripture-bridge-android-app/docs/requirements.md` (**APP**)
**Last updated:** 2026-08-20

---

## 1. Purpose and Relationship to the Other Documents

APP §18.2 removes all administrative UI from the Android application. DB §1.2 states plainly
that it specifies the data operations the console needs and *not* the console. Between them
they leave a hole, and the DB roadmap §8 names it: the console is a third deliverable with no
repository and no owner, and the pilot gate cannot be met without it.

**This document fills that hole.** It is the requirements document for the
`scripture-bridge-web` repository.

It is a companion, not a subordinate. Where DB fixes the data operations, this document is
bound by them. Where DB is silent — who may operate the console, how they authenticate, what
the console refuses that the database would accept — this document decides.

### 1.1 This document specifies

- Which administrative operations exist, and which are deliberately absent (§6, §14.2).
- How the console reaches the backend, and why not the way DB's grants imply (§4).
- Who an operator is, how they are authenticated, and how their identity reaches the audit
  trail (§5).
- Console-level policy: the rules enforced here and nowhere else (§7).
- Handling of the service key, and the security properties that follow from it (§9).
- Configuration, preflight, deployment shape, and testing (§11, §12).

### 1.2 This document does not specify

- The database schema, RLS, or the behaviour of any `api.*` function. Those are DB's, and this
  document quotes them rather than restating them.
- The Android application, which never talks to the console and does not know it exists.
- Visual design beyond the interaction requirements in §13.

### 1.3 Standing constraints inherited

These bind this document directly and are not restated as new requirements.

| Requirement | Source | Effect here |
|---|---|---|
| A console holds the service key in a server-side component; a browser-bundle console is not deliverable | DB R-RLS-3, roadmap §8 | §3, §9.1 |
| Every service-key operation is written to `app.audit_log` with the acting operator | DB R-AUTH-DB-12 | §5.4, §8 |
| Accounts are created through the GoTrue admin API, pre-confirmed | DB R-AUTH-DB-5 | §6.5 |
| `must_change_password` is cleared only by a verified change | DB R-AUTH-DB-7 | §6.6 |
| Password reset for another user is a console operation | DB R-AUTH-DB-11, APP R-AUTH-7 | §6.6 |
| Self-registration is disabled | DB R-AUTH-DB-1, APP R-API-9 | §6.5, §11.2 |
| The versification scheme is immutable per project | DB R-DATA-8 | §6.1, §7 |
| Errors carry a machine-readable code | DB §11.2, R-ERR-1 | §8 |
| No error payload contains verse text, a display name, or a token | DB R-ERR-4 | §8, §9.1 |
| Project setup, membership, assignment, and reopen have no app-facing surface | DB migration 0015 | §6 |

---

## 2. Why the Console Exists

Three things are true at once, and together they make this repository load-bearing:

1. The app has no administrative UI, by design (APP §18.2).
2. The database exposes project creation, membership, assignment, and reopen to `service_role`
   only — a project admin signed into the app must not be able to reassign chapters or reopen
   approved work (DB migration 0015).
3. Self-service password recovery is disabled and cannot work anyway, because identifiers may
   be synthetic addresses on a project-controlled domain that receive no mail (APP R-AUTH-2,
   R-AUTH-7).

- **R-ARCH-WEB-1.** The console is the only surface through which an account, a project, a
  membership, an assignment, a password reset, or a chapter reopen can come into existence.
  `scripture-bridge-db/scripts/provision.sh` covers this for development through M4 and is
  replaced by the console before the pilot.
- **R-ARCH-WEB-2. Password reset is the console's most important function**, not project
  creation. A project can be created by a developer with psql once; a translator locked out
  mid-workshop, whose password was communicated out of band months ago, cannot be recovered by
  anything else at all.

---

## 3. Architecture

### 3.1 Decision

- **R-ARCH-WEB-3. One server-rendered application**, with no browser-reachable API of its own.
  Reads happen in Server Components; writes happen in Server Actions, which are POST endpoints
  scoped to a form and origin-checked by the framework. The browser holds a session cookie and
  nothing else.
- **R-ARCH-WEB-4. No configuration value is exposed to the browser.** No `NEXT_PUBLIC_*`
  variable may exist in this repository. The browser has no legitimate need for a Supabase
  credential of any kind here, and a build that introduces one has introduced a way to leak it.
- **R-ARCH-WEB-5.** Every module that reads configuration or opens a connection imports
  `server-only`, so importing it from a Client Component is a build failure rather than a
  runtime leak.

**Rejected alternative: a single-page app plus a small API tier.** It buys a familiar split and
costs a second deployable, a second authorisation surface to audit, and a browser-reachable API
whose every endpoint must independently re-check the operator's session. The console has perhaps
fifteen operations; a tier of infrastructure to separate them from the pages that call them is
not worth the audit surface.

**Rejected alternative: static hosting.** Not available at any price. A statically hosted
console would have to ship the service key to the browser, which DB R-RLS-3 forbids and roadmap
§8 names explicitly as not a deliverable shape. Recorded here because it is the first thing
anyone asks.

### 3.2 Consequence to accept

The console must run somewhere that executes server code and can reach Postgres, not merely a
CDN. §11.3 covers the deployment shapes that satisfy this.

---

## 4. How the Console Reaches the Backend

### 4.1 Decision

- **R-CONN-WEB-1.** Data reads and every `api.*` call go over a **direct Postgres connection**.
- **R-CONN-WEB-2.** Account creation and password setting go over the **GoTrue admin API**,
  because DB R-AUTH-DB-5 requires it and because writing to `auth.users` would couple the
  console to GoTrue's internal schema.

This is the same split `scripture-bridge-db/scripts/provision.sh` uses — the roadmap's
designated stand-in for this tool.

### 4.2 Why not PostgREST, which is what DB's grants imply

Migration 0015 revokes each console function from `public` and `authenticated` and grants it to
`service_role`. A grant to `service_role` means something only over PostgREST. So the intended
call was `POST /rest/v1/rpc/create_project`. Two things prevent it:

1. **`service_role` is never granted `USAGE` on schema `api`.** Supabase's stock role setup
   grants schema usage for `public` only, and migration 0001 grants `api`, `app`, and `ref` to
   `authenticated` alone. `EXECUTE` without schema `USAGE` is inert, so every console function —
   and `api.anonymise_profile`, granted the same way in migration 0012 — fails as
   `service_role`. Nothing in that repository exercises the path: pgTAP runs as `postgres`,
   `provision.sh` uses psql, and `smoke-http.sh` covers only `authenticated`.
2. **Three read surfaces are not exposed at all.** Project members, the audit log, and the book
   canon live in `app` and `ref`, which PostgREST cannot reach by design (DB R-SCHEMA-2), and no
   `api` view or RPC covers them. A PostgREST-only console could not display its own audit trail.

- **R-CONN-WEB-3.** The console must not require a change to `scripture-bridge-db` in order to
  run. This is what settles the choice: the direct connection needs nothing, and a PostgREST
  console needs a migration on another repository's timeline.
- **R-CONN-WEB-4.** The data path is confined to one module, so adopting PostgREST later is one
  file's worth of change. `docs/architecture.md` §2 carries the migration that would be needed.

### 4.3 Consequences to accept

- **R-CONN-WEB-5.** The connecting role bypasses RLS. This is correct here and nowhere else: a
  coordinator provisioning a cohort is not a member of the projects they administer, and RLS
  would correctly show them nothing. It also means the console is trusted infrastructure — which
  it already was, holding the service key.
- **R-CONN-WEB-6.** The console needs network reach to Postgres, not only to the API. On a
  hosted project this means the pooler connection string.
- **R-CONN-WEB-7.** Because reads bypass RLS, the console must never render verse text (§14.2).
  The protection that normally prevents a coordinator reading a project's content is absent on
  this connection, so the restraint has to be in what the console asks for.

### 4.4 One implementation of the rules

- **R-CONN-WEB-8. Every write is a call to an `api.*` function.** No validation, no change-log
  entry, and no audit row is reimplemented in the console.

This is not a style preference. Migration 0015 exists because assignment through raw SQL wrote
no change-log entry, and delta sync is the only way the app learns anything changed (DB
R-SYNC-1) — so a chapter assigned by a coordinator never reached the translator's device. Any
rule duplicated in the console is a rule that can drift back out of agreement with the database,
and the failure is silent on the device rather than loud in the console.

### 4.5 Operation mapping

| Console operation | Served by |
|---|---|
| Create project | `api.create_project` |
| Add member / change role | `api.add_project_member` |
| Assign chapter | `api.assign_chapter` |
| Reopen chapter | `api.reopen_chapter` |
| Re-arm forced password change | `api.rearm_password_change` |
| Record account creation in the audit log | `app.console_audit` |
| Create account | `POST /auth/v1/admin/users` |
| Set another user's password | `PUT /auth/v1/admin/users/{id}` |
| Verify an operator's own password | `POST /auth/v1/token?grant_type=password` (anon key) |
| All reads | SQL against `app`, `ref`, and `auth.users` |

---

## 5. Operator Identity and Authentication

Migration 0015 states the problem: `actor_kind = 'console'` with a null profile records that *a
console* did something and not *which coordinator*. The console authenticates its own operators
outside the database schema and passes a label.

### 5.1 Who an operator is

- **R-AUTH-WEB-1.** An operator is an ordinary auth user whose email address also appears in the
  console's `CONSOLE_OPERATORS` allowlist. Both conditions are necessary.
- **R-AUTH-WEB-2.** The allowlist is re-evaluated on **every request**, not only at sign-in.
  Removing an operator takes effect on their next click, not when their cookie happens to lapse.
- **R-AUTH-WEB-3.** Operators are matched case-insensitively. A coordinator typing
  `Coordinator@example.org` at 2am in a field office must not be told their credentials are
  wrong.

**Rejected alternative: a separate credential store** — operator addresses and bcrypt hashes in
the environment. It removes GoTrue from sign-in and adds a second set of passwords to manage,
rotate, and lose. Account provisioning already requires the admin API, so the dependency is not
avoidable in any useful sense.

### 5.2 Sign-in

- **R-AUTH-WEB-4.** The operator's password is verified against GoTrue using the **anon** key
  and the ordinary password grant. The console holds no password of its own.
- **R-AUTH-WEB-5.** The tokens GoTrue returns are **discarded**. The console never reads project
  data with an operator's JWT: RLS would filter a non-member to nothing, and holding a
  long-lived refresh token for a privileged human is a liability with no compensating benefit.
- **R-AUTH-WEB-6.** A refusal is worded identically whether the address is absent from the
  allowlist, absent from GoTrue, or present with the wrong password. Distinguishing them
  confirms the existence of an account to someone who has no business here.
- **R-AUTH-WEB-7.** Sign-in attempts are rate-limited per address, in front of GoTrue's own
  limits (DB R-API-DB-4), which are tuned for a cohort signing in at once and are not a
  brute-force control for a console that can create accounts.

### 5.3 Sessions

- **R-SESS-WEB-1.** On success the console issues its own session: an HMAC-signed, `httpOnly`,
  `SameSite=Lax` cookie, `Secure` outside development, carrying the operator's email, their auth
  user id, and an expiry.
- **R-SESS-WEB-2.** The signing key is at least 32 bytes of entropy. It authenticates a cookie
  that grants service-key-backed powers.
- **R-SESS-WEB-3.** Default lifetime is **8 hours** — one working day, re-authenticated daily.
  Deliberately unlike the app's indefinite sessions (DB R-AUTH-DB-9): a translator's device is
  personal and offline for days, while a console operator is at a desk with connectivity, and
  the asymmetry in what the two can do justifies the asymmetry in session length.
- **R-SESS-WEB-4.** Signature and expiry are verified on every request, in addition to the
  allowlist check of R-AUTH-WEB-2.

### 5.4 The operator label

- **R-AUDIT-WEB-1.** Every `api.*` call made by the console passes the acting operator as
  `p_operator`, in the form `<email>@console`. The suffix mirrors `provision.sh`'s
  `<user>@provision.sh` so an audit reader can tell a console action from a script action
  without consulting a second system.
- **R-AUDIT-WEB-2.** No console operation may be performed without a session, and therefore no
  console operation can reach the database without an operator label. This is what satisfies DB
  R-AUTH-DB-12 in practice rather than in principle.

---

## 6. Console Operations

Each operation below is required for the pilot gate unless marked otherwise.

### 6.1 Create a project

- **R-FN-WEB-1.** The console creates a project with a name, language name, language code,
  script code, text direction, versification scheme, and a set of books, and materialises those
  books in full.
- **R-FN-WEB-2.** The form must state that the versification scheme is permanent before it is
  chosen. It determines every chapter's verse count, and a wrong choice surfaces at export, long
  after translation has started (DB R-DATA-8, roadmap M0).
- **R-FN-WEB-3.** Only schemes with seeded versification data may be selected. A scheme that is
  registered but empty — `org`, today — always fails with `versification_missing`, and offering
  a choice that always fails is a trap.
- **R-FN-WEB-4.** The book selector shows the cost of the selection before it is committed:
  the number of books and the number of verse rows that will be written. A whole-Bible project
  writes roughly 31,000 rows and takes appreciably longer than one gospel; an operator who was
  not told that will assume the console has hung.

### 6.2 Membership

- **R-FN-WEB-5.** The console adds a person to a project as `admin`, `translator`, or
  `reviewer`, and changes an existing member's role.
- **R-FN-WEB-6.** Adding an existing member with a different role **is** the role-change path —
  `api.add_project_member` upserts, and no separate operation exists. The confirmation reports
  the previous role, so the operator learns what actually happened rather than what they
  intended.
- **R-FN-WEB-7.** Erased profiles are not offered. They have no account to sign in with, so
  adding one creates a membership nobody can act on.

### 6.3 Assignment

- **R-FN-WEB-8.** The console assigns a translator and a reviewer to a chapter, and clears
  either.
- **R-FN-WEB-9.** Both assignees are always submitted together. The RPC takes the pair and
  treats a missing value as *unassigned*, so posting only the edited field would silently clear
  the other — a bug that surfaces as a reviewer wondering why their queue emptied.
- **R-FN-WEB-10.** Only project members are offered. Assigning a non-member produces a chapter
  its assignee cannot read; the RPC refuses it, and the refusal would look like a bug rather
  than a mis-assignment.
- **R-FN-WEB-11.** The console must state that saving an assignment is what makes it reach the
  device. The app learns of it through delta sync and no other way, so an operator who believes
  assignment is instant will mis-diagnose a translator's empty queue.

### 6.4 Reopen an approved chapter

- **R-FN-WEB-12.** The console reopens an approved chapter, returning it to `in_progress` and
  discarding the approval and submission timestamps (DB R-FN-14, APP §8.1).
- **R-FN-WEB-13.** Reopen is presented as destructive: visually distinct from safe controls, and
  confirmed before it is sent. An approved chapter is read-only (APP R-WF-3), and this is the
  only way back — which also means it is the only way to undo work that was correctly finished.
- **R-FN-WEB-14.** A written reason is required (§7).

### 6.5 Create an account

- **R-FN-WEB-15.** The console creates a pre-confirmed account through the admin API with a
  display name, an email address, and an admin-chosen initial password.
- **R-FN-WEB-16.** `must_change_password` is left at its default of `true`. The initial password
  is known to at least two people by construction, and RLS withholds all project content until
  it is changed (DB R-AUTH-DB-8).
- **R-FN-WEB-17.** The initial password is **displayed, not masked**. The operator has to read
  it aloud or write it down; a masked field they cannot verify produces transcription errors
  that present as a translator who cannot sign in.
- **R-FN-WEB-18.** The console offers a generated password. A suggestion an operator can accept
  beats one they invent under time pressure.
- **R-FN-WEB-19.** If the account is created but no profile row appears, the console reports it
  as a failure naming the trigger (DB R-AUTH-DB-6). Such an account can sign in but is invisible
  to every query in the schema, and presents to the translator as an app with no data.

### 6.6 Reset a password

- **R-FN-WEB-20.** The console sets another user's password and re-arms the forced change.
- **R-FN-WEB-21. Both steps are required.** `api.rearm_password_change` re-sets
  `must_change_password` *and* re-fingerprints the new hash so that
  `complete_password_change` later compares against the right one (DB R-AUTH-DB-7). The admin
  API alone leaves a translator able to sign in with a password a coordinator knows and no
  forced change pending — precisely the situation the flag exists to prevent.
- **R-FN-WEB-22.** The two steps cannot be atomic: one is HTTP to GoTrue, the other is a
  database call. **When the first succeeds and the second fails, the console reports failure
  and names the state it left behind**, instructing the operator to run the reset again. It must
  not report success, and it must not retry silently: an operator who believes a reset completed
  will hand over the password and move on.

### 6.7 Read surfaces

- **R-FN-WEB-23.** The console displays, per project: books, chapters, workflow state,
  assignments, flagged-verse counts, and verse progress.
- **R-FN-WEB-24.** Progress is read from the maintained counters on `app.chapter`, never by
  aggregating verse rows (DB R-PERF-1). Summing 31,000 verses for a dashboard is the query that
  finds the statement timeout in the field rather than in review.
- **R-FN-WEB-25.** Every projection of a person tolerates a null display name and a null
  `auth_user_id`. Erasure drops both (DB R-DATA-4), and a tombstoned profile still owns
  revisions and approvals and must keep rendering.

### 6.8 Audit log

- **R-AUDIT-WEB-3.** The console displays `app.audit_log` with the operator, target, and before
  and after values, filterable by action and by target.
- **R-AUDIT-WEB-4.** The audit view is read-only, and no console path may write to the table
  other than through `app.console_audit`. The table is append-only at the database level, so
  this is a property of the system rather than a promise of the console.

### 6.9 USFM export

- **R-FN-WEB-26.** The console exports a book as USFM, downloaded as a file.
- **R-FN-WEB-27. The export is structurally plain, and this is not a choice made here.** DB
  R-USFM-1 stores translated verse text only; DB R-USFM-2 offers two futures — markers preserved
  in a sidecar (`app.chapter_markup`), or an export the publisher's operator re-marks. No sidecar
  exists in the schema, and DB R-USFM-3 forbids export from requiring a schema element the app's
  write path does not maintain. **Structurally plain is therefore the only output the stored data
  can support.** If the sidecar is ever built, that decision belongs in the database repository
  and this requirement changes after it, not before.
- **R-FN-WEB-28.** The file carries `\id`, `\ide UTF-8`, `\h`, `	oc1–3`, `\mt1`, and per
  chapter a `\c` followed by a single `\p` and its verses. The `\p` is the only structure
  asserted: USFM expects verses inside a paragraph, and anything beyond that would be inventing
  structure nobody recorded.
- **R-FN-WEB-29.** An untranslated verse is exported as a bare ` N`. Dropping it would read to
  the publisher as a deliberate omission rather than as work not yet done, and the count is
  reported to the operator before they send the file on.
- **R-FN-WEB-30.** Verse text is flattened to one line. A newline would end the `` line and
  make the remainder body text belonging to no verse — the file still opens and the verse is
  silently truncated, which is the worst failure available here.
- **R-FN-WEB-31.** A backslash in verse text is reported and the text is exported **unchanged**.
  It cannot be escaped in USFM, and altering a translator's text during export is not the
  console's decision to make.
- **R-FN-WEB-32.** Filenames follow Paratext's `<NN><CODE><ABBREV>.usfm`, where `NN` reserves 40:
  `ref.book_canon` numbers the New Testament 40–66 and Paratext numbers it 41–67. Off by one and
  the publishing tool sorts Matthew before Malachi.
- **R-FN-WEB-33.** Export is recorded in the audit log. It is read-only and takes no lock, but it
  is the one operation that removes translation text from the system, and "who took a copy, and
  when" is asked after the fact or not at all.
- **R-FN-WEB-34.** The export endpoint verifies the session itself. It returns project content
  and is a route handler, so it does not pass through the layout guard (R-SEC-WEB-5).

**Import is not built** and is blocked, unlike export. DB R-USFM-2 requires the round-trip
question resolved *before* import exists: a source file's markers cannot be reconstructed from
verse-text-only storage, so importing one would silently discard them.

---

## 7. Console-Level Policy

Three rules are enforced by the console and not by the database. Each is recorded here because
the database will accept what the console refuses, and someone comparing the two will otherwise
read the difference as a bug.

- **R-POLICY-WEB-1. A reopen requires a written reason.** `api.reopen_chapter` accepts a null
  note. The audit row is the only place the reason for undoing an approval is ever written down,
  and "reopened by someone, at some point" is not an answer to the question asked six months
  later.
- **R-POLICY-WEB-2. A new project must contain at least one book.** The RPC accepts an empty
  array. Because the scheme is immutable afterwards, an empty project cannot be corrected by
  editing — only by creating a second one and abandoning the first.
- **R-POLICY-WEB-3. An initial or reset password is at least 12 characters.** GoTrue's default
  floor is six. This password is spoken over a phone line and lives until a forced change that
  may be days away on a device that has not yet been online.

- **R-POLICY-WEB-4.** Nothing else is re-validated in the console. Role values, membership
  before assignment, workflow transitions, and versification validity are refused by the
  function, surfaced by the error model, and not second-guessed here (R-CONN-WEB-8).

---

## 8. Error Model

DB R-ERR-1 gives every raised exception `ERRCODE = 'PT<status>'`, `MESSAGE = '<code>'`, and
`DETAIL` as a JSON object. Over a direct connection these arrive as the three fields of a
driver error.

- **R-ERR-WEB-1.** The console normalises those into a code, an HTTP-equivalent status,
  structured details, and an operator-facing sentence.
- **R-ERR-WEB-2.** The typed code is shown alongside the sentence. It is what an operator quotes
  when they ask for help, and what a developer greps for.
- **R-ERR-WEB-3.** `invalid_argument` carries the offending field in `details`, and the message
  names it. "One of the values is not allowed" is not actionable.
- **R-ERR-WEB-4.** Only codes the console can actually provoke get a written message. Codes
  belonging to the translator's write path — `chapter_locked`, `text_not_normalized`, the
  idempotency pair — are deliberately left to the generic form: the console never calls those
  RPCs, and an invented message for an impossible error is worse than the raw code.
- **R-ERR-WEB-5.** Anything that is not a `PT<nnn>` exception is reported as a failure of the
  console or its dependencies, not dressed up as an application error. The raw message is
  preserved, because the reader is an operator who can act on "connection refused".
- **R-ERR-WEB-6.** The configuration and connection failures are distinguished on screen and
  each names its remedy. They are the two things that actually go wrong, and a generic
  "something went wrong" page conceals both.
- **R-ERR-WEB-7.** No message rendered by the console may contain verse text, a display name, or
  a token (DB R-ERR-4). Console screens are shared over the shoulder and photographed.

---

## 9. Security

### 9.1 Keys

- **R-SEC-WEB-1.** The service key is used for the GoTrue admin API and nothing else. It is
  never logged, never returned in a response body, and never placed in an error message.
- **R-SEC-WEB-2.** Neither key nor the database URL may appear in a client bundle. This is
  verified as part of the build check (§12).
- **R-SEC-WEB-3.** GoTrue's own error bodies are read for a message but never echoed wholesale:
  they can contain the submitted address and, on some paths, the rejected password.
- **R-SEC-WEB-4.** Configuration is validated at first use and fails loudly and specifically. A
  console that starts with a missing key and fails at the moment a coordinator resets a password
  has chosen the worst possible time to discover it.

### 9.2 Where authorisation is checked

- **R-SEC-WEB-5.** Every Server Action re-checks the session itself. A layout guard protects
  rendering, not writing, and an action reached directly does not pass through a layout. **The
  guard belongs where the write is.**
- **R-SEC-WEB-6.** Route-level middleware may redirect on the absence of a session cookie as a
  convenience, but is not the authorisation check and must not be relied on as one — it runs in
  an environment that cannot verify the signature.

### 9.3 Transport and headers

- **R-SEC-WEB-7.** The console sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`,
  `nosniff`, `Referrer-Policy: no-referrer`, and a Content-Security-Policy restricting scripts,
  styles, and connections to same-origin.
- **R-SEC-WEB-8.** Every response is `no-store`. Beyond the confidentiality argument, a stale
  render is how two coordinators assign the same chapter to two people.
- **R-SEC-WEB-9.** The console is not indexed: `robots` is `noindex, nofollow`.
- **R-SEC-WEB-10.** The console is served over TLS anywhere but a developer's machine, and the
  session cookie is `Secure` outside development.

### 9.4 Abuse

- **R-SEC-WEB-11.** The sign-in limiter is per-address and in-process. **This is per-instance**,
  and is honest only for a single-instance deployment; behind more than one replica the
  effective ceiling multiplies. A multi-replica deployment requires shared storage for it, and
  that must be a decision rather than a discovery (§15 #3).

---

## 10. Non-Functional Targets

The console is an internal tool used by a handful of people. Its budgets are set by human
patience and by the cost of the underlying operation, not by DB §15's device-facing targets.

| Operation | Target |
|---|---|
| Any list or detail page | < 1 s to first render |
| Assignment, membership, reopen, password reset | < 2 s round trip |
| Create project — one gospel | < 5 s |
| Create project — whole Bible | May exceed 60 s; must not be cancelled by the host (§11.3) |

- **R-NFR-WEB-1.** Project creation is the only operation whose duration is bounded by data
  volume rather than by round trips, and it is the one that decides where the console can be
  deployed.
- **R-NFR-WEB-2.** Any control that triggers a non-idempotent operation disables itself while
  in flight. `create_project` takes seconds and is not idempotent; a live button during that
  window invites the double click that creates two projects.

---

## 11. Operations

### 11.1 Configuration

- **R-OPS-WEB-1.** All configuration comes from the environment: database URL, Supabase URL,
  service key, anon key, operator allowlist, session secret, session lifetime.
- **R-OPS-WEB-2.** No secret is committed. The repository carries a documented example file and
  nothing else.

### 11.2 Preflight

- **R-OPS-WEB-3.** The repository provides a preflight command that verifies, against a live
  stack: every configuration value; the Postgres version against DB R-PLAT-DB-1; the presence of
  `app`, `api`, and `ref`; each `api.*` function the console calls; `app.console_audit`;
  `app.audit_log.actor_label`; that some versification scheme is seeded; that the admin API
  accepts the service key; and that self-registration is disabled (DB R-AUTH-DB-1).
- **R-OPS-WEB-4.** The preflight writes nothing and prints no key.
- **R-OPS-WEB-5.** A database whose migrations predate the console API must be reported as such,
  naming the migration. The alternative is a coordinator discovering it at the point of use.

### 11.3 Deployment

- **R-OPS-WEB-6.** The console requires a host that executes server code and can reach Postgres.
  Static hosting is excluded by §3.1.
- **R-OPS-WEB-7. A long-lived single instance is the preferred shape** — a container or a small
  VM. It gives a genuine connection pool, no host-imposed request ceiling on project creation,
  and a rate limiter that behaves as specified.
- **R-OPS-WEB-8.** On a serverless host, three things must be addressed and recorded: the
  connection string must be the pooler; the pool size must be reduced, since each instance holds
  its own; and the host's maximum request duration must accommodate project creation or projects
  must be created a few books at a time (R-NFR-WEB-1).
- **R-OPS-WEB-10. The database connection verifies TLS, and the CA is supplied rather than the
  check disabled.** A hosted Supabase project presents a chain absent from Node's default store,
  so strict verification fails; the remedy is `DATABASE_CA_CERT`, not `rejectUnauthorized:
  false`. This connection carries every project's translation text and is made by the component
  holding the service key — encrypted-but-unauthenticated is a poor default for it. Skipping
  verification remains available as `?sslmode=no-verify` in the URL, where it is visible to
  anyone reading the configuration rather than buried in code.
- **R-OPS-WEB-11.** The TLS decision is made in one place shared by the console, the preflight,
  and the verification sequence. Three programs connect to this database; a decision made three
  times will differ in whichever of them is run least.
- **R-OPS-WEB-12.** A TLS failure is reported with the remedy, not just the driver's message.
  "self-signed certificate in certificate chain" is true of every hosted project and says nothing
  about what to do; it is the first error anyone pointing the console at a real project will see.
- **R-OPS-WEB-9.** The service key rotates with the database repository's rotation runbook
  (DB R-OPS-4). The console holds a copy, and a rotation that misses it takes account creation
  and password reset offline — the two operations whose absence is least tolerable.

---

## 12. Testing

- **R-TEST-WEB-1.** The type checker and a production build pass. Both run before any change is
  considered done.
- **R-TEST-WEB-2.** The client bundle is checked for the service key, the database URL, the
  session secret, and any server-only module. Automated as `check-bundle` and run in CI. It
  asserts R-SEC-WEB-2 — the requirement most expensive to get wrong, because its failure
  produces no error and nobody notices by using the console.
- **R-TEST-WEB-3.** Every table, column, and function signature the console references is
  verified against the migrations in `scripture-bridge-db`. The console composes SQL the
  compiler cannot check, so a renamed column is otherwise found at runtime by an operator.
  Automated as `check-schema`; CI checks out that repository so the guard has something to
  compare against, since a guard with no migrations to read would pass vacuously.
- **R-TEST-WEB-6.** Both checks are negative-tested: each has been shown to fail on a
  deliberately introduced defect. A check that has never failed is a check nobody has confirmed
  is wired up.
- **R-TEST-WEB-8. No assertion may skip itself silently.** A check conditioned on fixture data
  that a fresh database does not contain will pass by not running, which is the same defect as a
  guard with nothing to compare against (R-TEST-WEB-3). Fixtures an assertion needs are created
  by the sequence, and their absence fails rather than skips. Found in the first green run: the
  non-member assignment check looked for "any other profile" and skipped itself, because a reset
  database held only the account the run had just created.
- **R-TEST-WEB-4. An end-to-end run against a live stack is required before the pilot.** It is
  automated as `verify-e2e` and runs in CI against a full Supabase stack, which is where the
  Docker and CLI dependencies live — they are not required on a developer's machine. The
  preflight of §11.2 runs first in that job, so a stack missing the console API is reported as
  that rather than as whichever operation happens to fail. **Satisfied 2026-08-20**; it now runs
  on every change rather than once.
- **R-TEST-WEB-5.** The end-to-end run covers, at minimum: create an account; confirm the
  profile trigger fired and `must_change_password` defaults true; create a project and confirm
  it materialised in full rather than as an empty shell; refuse an unseeded versification
  scheme; add a member and change their role; assign a chapter; **confirm the assignment wrote a
  change-log entry**; refuse assignment of a non-member; reopen an approved chapter and confirm
  the reason reached the audit log; refuse reopening a chapter that is not approved; reset a
  password, confirm the forced change is re-armed *and* re-fingerprinted, and confirm the
  account can actually sign in with the new password; and confirm every action appears in
  `app.audit_log` with the operator's label and none without one.
- **R-TEST-WEB-7.** The verification writes real data and does not clean up, so it refuses to
  run outside CI without an explicit flag. Project rows cascade nowhere (DB R-DATA-4), and
  deleting one is a runbook rather than a test fixture.

---

## 13. Interaction Requirements

Not visual design. These are the properties that decide whether an operation is performed
correctly by a tired person.

- **R-UI-WEB-1.** A destructive control never looks like a safe one, and reopen and password
  reset are confirmed before they are sent.
- **R-UI-WEB-2.** A permanent choice says so at the point of choosing, not in documentation.
- **R-UI-WEB-3.** Every operation reports what actually happened, in the database's terms —
  "role changed from translator to reviewer", not "saved".
- **R-UI-WEB-4.** Timestamps are rendered in UTC in a fixed format, so two operators in
  different places quote the same string when they compare notes.
- **R-UI-WEB-5.** The console is legible in both light and dark, and functions at the widths a
  laptop provides. Wide tables scroll within their own container rather than the page.

---

## 14. Scope

### 14.1 In scope for the pilot

1. Operator authentication, allowlist, and session (§5).
2. Project creation with book materialisation (§6.1).
3. Membership and role change (§6.2).
4. Chapter assignment (§6.3).
5. Chapter reopen (§6.4).
6. Account creation (§6.5).
7. Password reset with re-arm (§6.6).
8. Project, book, and chapter read surfaces with progress (§6.7).
9. Audit log display (§6.8).
10. USFM export (§6.9).
11. Preflight (§11.2).

### 14.2 Out of scope, deliberately

- **USFM import and export.** DB §14 leaves the round-trip decision open (DB §17 #4) and no RPC
  exists. Building it here would mean inventing that contract in the wrong repository.
- **Removing a project member.** No RPC exists, and `app.project_member` references profiles
  with `ON DELETE RESTRICT`. A removed member holding assignments leaves chapters assigned to
  someone who can no longer read them. Reassign first; removal is a runbook, not a button.
- **Anonymising a profile.** `api.anonymise_profile` exists and is irreversible by design. It is
  a legal process with a decision behind it, and one click from an account list invites the
  mistake it cannot recover from.
- **Editing verse text.** The console sees progress, never content. Translation is the app's
  job, and a coordinator editing verses over a connection that bypasses RLS would also bypass
  the revision-capture policy that makes history trustworthy (R-CONN-WEB-7).
- **Font upload.** DB §12.1 makes it a console operation and it is real work, but it is M5 and
  not on the pilot's critical path.
- **Project archival or deletion.** `app.project.archived_at` exists and nothing sets it. Until
  there is a reason to archive a project, a control that does it is a hazard with no use.
- **Multiple operator roles.** Every operator can do everything. A read-only auditor role is
  plausible and is not yet justified by anyone's actual need (§15 #4).

---

## 15. Open Questions and Risks

| # | Item | Type |
|---|---|---|
| 1 | **`service_role` lacks `USAGE` on schema `api`** (§4.2). The console works around it, but it means the grants in DB migrations 0012 and 0015 are inert as written, and `api.anonymise_profile` is unreachable by any HTTP caller. Should `scripture-bridge-db` fix the grant, or drop the pretence that these are HTTP-callable? | Dependency |
| 2 | **Deployment target is unchosen**, and it decides three things: pool size, whether project creation can complete in one request, and whether the rate limiter is honest (§11.3). | Decision |
| 3 | If the console is ever run behind more than one replica, the sign-in limiter needs shared storage (R-SEC-WEB-11). | Decision, follows #2 |
| 4 | Does a read-only operator role have a real user? A partner organisation wanting progress visibility without provisioning rights is the plausible case, and nobody has asked for it yet. | Decision |
| 5 | ~~The end-to-end run of R-TEST-WEB-5 has never executed.~~ **Closed 2026-08-20:** green in CI against a full stack, 39 assertions. The workflow needed one fix first, as expected. One criterion of roadmap M4 remains and is not automatable — confirming an assignment reaches a device through delta sync (#11). | Closed |
| 11 | **A chapter assigned through the console has never been shown to reach a device.** The verification proves the change-log entry exists; delta sync delivering it to a signed-in app client is untested from this side and needs the app team. | Verification |
| 6 | Session lifetime is asserted at 8 hours from the shape of a coordinator's day, not measured. Revisit if operators report being signed out mid-task. | Verification |
| 7 | Who holds the console's copy of the service key, and how is its rotation coordinated with DB R-OPS-4? Roadmap §8's ownership question, narrowed to the one operational consequence. | Dependency |
| 8 | Project creation for a whole Bible has never been timed against a hosted project, only reasoned about from the row count. It is the console's only volume-bound operation and the one that constrains deployment. | Verification |
| 9 | ~~There is no CI.~~ **Closed:** typecheck, schema guard, build, bundle check, and the M4 verification all run on push. Two consequences remain open — the schema guard only runs when *this* repository is pushed, so a migration landing in `scripture-bridge-db` breaks nothing until someone touches this one (#10), and the workflow has never executed (#5). | Closed |
| 10 | The cross-repository guard is one-directional. `scripture-bridge-db` does not know this console exists, so a migration that renames a column goes green there and red here only on the next push. A scheduled run, or a notification from that repository, would close the window — neither is built. | Decision |

---

## 16. Relationship to `docs/architecture.md`

This document says what must be true. `docs/architecture.md` says why the shape was chosen and
what was rejected, at greater length, for a reader deciding whether to change it. Where they
overlap — the data path in particular — this document is authoritative on the requirement and
that one is authoritative on the reasoning.
