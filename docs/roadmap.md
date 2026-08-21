# Scripture Bridge — Console Roadmap (scripture-bridge-web)

**Status:** Draft
**Companions:** `scripture-bridge-db/docs/roadmap.md` and
`scripture-bridge-android-app/docs/roadmap.md` — same milestone numbering, third track
**Requirements:** [requirements.md](requirements.md) (**WEB**), and the database and app
requirements documents (**DB**, **APP**)
**Last updated:** 2026-08-20

---

## 1. How to Read This

Milestones **M0–M5** are shared across the three repositories. A milestone number means the
same point in the project in all of them. This document covers the console track.

**No dates**, for the same reason the other two give none: durations depend on team shape, which
is still open, and invented dates get quoted. Each milestone has **exit criteria** — observable,
testable conditions — and a **relative size**.

**This track is different from the other two in one important way.** The database and app
roadmaps describe work that will be done. This repository arrived as a complete first cut of the
administrative surface, written in one pass and unverified. So the sequencing question here is
not "what do we build next" but "what do we have to prove before any of it can be believed" —
which is why M4's exit criteria, not its work list, are the substance of this document.

As of 2026-08-20 that sequence runs in CI and passes against a live stack. What remains of M4 is
the single criterion automation cannot reach (§4.2).

---

## 2. Where This Repository Enters

The DB roadmap §8 records this repository as unowned work and the highest-value thing that could
happen during M0. It stayed unowned through M1–M4, covered by `scripts/provision.sh` in that
repository, described there as the console stand-in.

The console therefore **enters at M4, with the backend already ahead of it**. It does not have
an M1, M2, or M3 of its own; the milestones it missed were covered by dev scripts, and there is
nothing to go back and build.

What it does carry forward is **M0 debt**: decisions the DB roadmap booked against M0 that were
never closed because they were the console's to close and the console did not exist. Those are
§4.1.

**Consequence to accept:** this track has no slack. Every other milestone has a successor that
can absorb slippage; the console's only successor is the pilot gate.

---

## 3. Critical Path

```text
first cut       M4 verification      deployment        M5 field         pilot
(delivered) ──► in CI, GREEN    ──►  target + CI  ──►  readiness   ──►  gate
                                                       (fonts, export)
                     │                    │                 │
                     └── delta sync       └── blocked       └── blocked on
                         to a device          on §4.1 #2        DB §17 #4
                         still human
```

The three things that can stall this path, in order of likelihood:

1. ~~Nothing here has ever touched a real database.~~ **Closed 2026-08-20.** The verification
   runs in CI against a full stack and passes: 39 assertions covering provisioning, project
   materialisation, membership, assignment, reopen, password reset, and the audit trail. What is
   left of it is the delta-sync confirmation, which needs a device and a person (§4.2).
2. **The deployment target is unchosen** (§4.1 #2), and it decides three implementation details
   that are cheap now and awkward later: connection pool size, whether whole-Bible project
   creation survives a host's request ceiling, and whether the sign-in rate limiter is honest.
3. **USFM export has no contract** (DB §17 #4). It is the last thing the pilot needs and the
   only console feature that cannot be started at all until another repository decides
   something.

---

## 4. Milestones

### 4.1 Inherited M0 debt

**Size:** S (calendar time, not effort — this is asking people questions)
**Goal:** close the decisions the DB roadmap booked against M0 and left open because they were
the console's.

| # | Item | Source | Why it cannot wait |
|---|---|---|---|
| 1 | **Who owns this repository, and who holds the console's copy of the service key?** | DB §17 #7, roadmap §8 | The key must rotate with DB R-OPS-4. A rotation that misses the console takes account creation and password reset offline — the two operations whose absence is least tolerable |
| 2 | **Deployment target**: long-lived instance or serverless | WEB §15 #2 | Decides pool size, request ceiling, and rate-limiter honesty (WEB R-OPS-WEB-7/8, R-SEC-WEB-11) |
| 3 | **Who the console's operators are**, as a list of addresses | WEB R-AUTH-WEB-1 | The allowlist is configuration; without real names it cannot be deployed to anywhere real |
| 4 | Does `scripture-bridge-db` fix the `service_role` grant, or drop the pretence that its console functions are HTTP-callable? | WEB §15 #1 | Not blocking — the console works around it — but it leaves `api.anonymise_profile` unreachable by any caller, which is a live bug in that repository |

**Exit criteria**

- Every row answered in writing, in the requirements documents rather than in a side channel.
- An environment exists that the console can be deployed to, with its allowlist populated.

---

### 4.2 M4 — The administrative surface

**Size:** S remaining (the surface is built and the verification passes; one criterion is left)
**Goal:** a coordinator can perform every provisioning and workflow operation, and it is known
to work rather than believed to work.

**Delivered in the first cut**

- Operator authentication, allowlist, session, sign-in rate limiting (WEB §5).
- Project creation with book materialisation; membership and role change; chapter assignment;
  chapter reopen (WEB §6.1–6.4).
- Account creation and password reset with re-arm (WEB §6.5–6.6).
- Project, book, and chapter read surfaces with counter-based progress (WEB §6.7).
- Audit log display, filterable (WEB §6.8).
- Preflight command covering configuration, schema, functions, seeded reference data, admin API,
  and the self-registration setting (WEB §11.2).

**Built since, and now the milestone's machinery rather than its remaining work**

- **CI** — typecheck, schema guard, build, bundle check, and the verification job
  (`.github/workflows/web.yml`).
- **The client-bundle check** (WEB R-TEST-WEB-2), previously a habit, now a gate. Negative-tested
  against each shape it looks for.
- **The cross-repository schema guard** (WEB R-TEST-WEB-3) — parses the migrations, resolves
  every table, column, and function the console's SQL references, and fails on divergence.
  Negative-tested against a renamed column, a renamed table, and a changed arity.
- **The M4 verification sequence** (WEB R-TEST-WEB-5), running against a full stack started in
  CI. Docker and the Supabase CLI live there rather than on a developer's machine, which is what
  made the run possible at all.

**What the first green run established (2026-08-20)**

- Every operation in §6 works against a real database. The profile trigger fires, Matthew
  materialises to 1,071 verses rather than an empty shell, an unseeded scheme is refused with a
  typed error, a role change reports its predecessor, reopen discards the approval and preserves
  the reason, and a reset password actually signs in.
- **Assignment writes a change-log entry.** This is the defect migration 0015 was written to fix,
  and the console was its first caller outside pgTAP. It is now confirmed.
- Every privileged action reached `app.audit_log` carrying the operator label, and none reached
  it without one.
- The console boots, serves its sign-in page, redirects an unauthenticated request for
  `/projects`, and sends its security headers.

Three defects surfaced on the way, none of which a passing build could have caught: a dev CSP
that blocked React hydration, a sign-in path that turned an unreachable auth service into a blank
500, and a CI job that set two environment variables per step and missed one. All fixed.

**Remaining, and it is one thing**

- **A chapter assigned through the console must be shown to reach a device.** The verification
  proves the change-log entry exists; it does not prove the app receives it. That needs a device,
  a signed-in translator, and a person watching — and it is the only part of this milestone
  automation does not reach.

**Exit criteria**

- ✅ **The verification job is green** — the R-TEST-WEB-5 sequence ran end to end against a real
  stack and every step appears in `app.audit_log` with the acting operator.
- ⬜ **A chapter assigned through the console reaches a signed-in app client through delta sync.**
  Still open, and human.
- ✅ `npm run check-stack` passes against that stack — it runs first in the job, so this is
  implied by the above, but it is the criterion an operator can check by hand before a
  deployment.
- ✅ CI fails on a type error, a build error, a secret in the client bundle, or a schema
  divergence.

---

### 4.3 M5 — Field readiness

**Size:** M
**Goal:** the operations that are only needed once real translators are using real devices.

**Work**

- **Font upload** (DB §12.1, R-STORE-1/2/3). A console operation by construction: the app
  verifies the `sha256` it was given and must never be able to replace the asset it is checking.
  Needs the storage path, the integrity hash, and the licence gate — a console screen and no new
  database work.
- **USFM export**, in whichever shape DB §17 #4 decides. Blocked, and not startable early: the
  decision determines whether export is a download of generated text or a round-trip through
  sidecar markup, and those are different features.
- **A destructive-operation runbook for the console**, alongside DB R-OPS-5. Reopen is the only
  destructive operation the console exposes; what is missing is the written answer to "a
  coordinator reopened the wrong chapter, now what".
- Service-key rotation runbook entry (DB R-OPS-4), naming the console as a holder.
- Whatever the M4 verification run turns up. Assume it turns something up.

**Exit criteria**

- A font is uploaded through the console and rendered by a device that did not previously have
  it.
- One chapter is exported in a form the partner organisation's publishing tooling opens cleanly
  — the console's half of the pilot gate's vertical slice.
- The rotation runbook lists every service-key holder, and the console is one of them.

---

## 5. The Pilot Gate

Not a milestone — the condition for putting this in front of translators. The DB roadmap states
the console's share of it in one line: *a console exists and a coordinator can provision an
account, a project, and an assignment without a developer.*

That is the test to run literally. Not "the screens exist" — **a coordinator who has not seen
the code, given only a URL and their own credentials, provisions a working translator account
and assignment while nobody who built it is in the room.**

- Every step they get stuck on is a defect, including the ones that are only wording.
- If they need to be told what a versification scheme is, WEB R-FN-WEB-2 is not satisfied.
- If they set a password and cannot read it back over a phone line, WEB R-FN-WEB-17 is not
  satisfied.

**Exit criteria**

- The above has happened, with a real coordinator, and what they got stuck on is written down.
- Password reset has been performed by a coordinator on an account that is genuinely locked out,
  and the translator signed in afterwards — the path APP R-AUTH-7 makes the only alternative to
  permanent lockout.

---

## 6. Cross-Repo Dependencies

| This repo needs | From | Status |
|---|---|---|
| A runnable stack to verify against — local or hosted staging | `scripture-bridge-db` M1 deliverable | Available; not yet used here |
| The USFM export contract and its RPC | `scripture-bridge-db` M5, gated on DB §17 #4 | Open |
| Font storage bucket and the `app.font` write path | `scripture-bridge-db` M5, DB §12.1 | Open |
| A decision on the `service_role` grant | `scripture-bridge-db` | Open, non-blocking (§4.1 #4) |
| Ownership and the service-key custody answer | Project decision, DB §17 #7 | Open, blocking deployment |

| This repo delivers | Which unblocks |
|---|---|
| Account, project, membership, and assignment provisioning without a developer | The pilot gate, which cannot be met otherwise |
| Password reset | APP R-AUTH-7 — the only path out of a field lockout |
| **The first real exercise of the console API** | `scripture-bridge-db` migration 0015's functions have been called only by pgTAP as `postgres` and by `provision.sh` via psql. The console is the first caller in the shape they were designed for, and its verification run is the first evidence they behave as specified |
| A retirement path for `scripture-bridge-db/scripts/provision.sh` | That script stops being load-bearing once M4's exit criteria are met, and can go back to being a dev convenience |

---

## 7. Post-MVP

In roughly the order the requirements justify, not a commitment:

- **A read-only operator role** (WEB §15 #4), if a partner organisation wants progress
  visibility without provisioning rights. Every operator can currently do everything, which is
  correct for one coordinator and wrong for five.
- **Project archival.** `app.project.archived_at` exists and nothing sets it. A control for it
  is a hazard until there is a reason to archive a project.
- **Bulk assignment.** Assigning a gospel one chapter at a time is 28 interactions. Worth doing
  once someone has actually done it and can say what the right grouping is — by book, by
  translator, by range — rather than guessing now.
- **Shared-storage rate limiting**, if §4.1 #2 lands on a multi-replica deployment
  (WEB R-SEC-WEB-11).
- **Adoption of the PostgREST path**, if `scripture-bridge-db` closes §4.1 #4 by fixing the
  grant and adding console read surfaces. One module changes (WEB R-CONN-WEB-4). No user-visible
  benefit; it would be done for architectural consistency, which is a reason but not an urgent
  one.
- **Anonymisation** (`api.anonymise_profile`), if a real erasure request arrives. Deliberately
  not built in advance: it is irreversible, and a control nobody has needed yet is a control
  nobody has thought carefully about.

---

## 8. Risk Register

| Risk | Impact | Where it bites | Mitigation |
|---|---|---|---|
| ~~The first cut has never run against a database~~ | — | — | **Retired 2026-08-20**: the verification passes in CI and now runs on every change, so a regression surfaces on the pull request rather than in front of a coordinator |
| Service key leaks from the console | Full compromise of every project's data | Any | `server-only` guards, no `NEXT_PUBLIC_*`, and a bundle check that fails the build — negative-tested against each shape it looks for |
| Key rotation misses the console | Account creation and password reset silently stop working | Any, after a rotation | §4.1 #1; the console named in DB R-OPS-4's runbook |
| Deployment target chosen late | Rework of pool size and project-creation flow after the fact | M4/M5 boundary | §4.1 #2, forced to a decision before deployment |
| Whole-Bible project creation exceeds a request ceiling | A project half-materialised, or an operator who cannot tell | M5, first large project | Timed against a hosted project before the pilot (WEB §15 #8); serverless constraints in R-OPS-WEB-8 |
| Schema drift in `scripture-bridge-db` | A renamed column becomes a runtime error found by an operator | Any migration | The schema guard, in CI. **One-directional**: that repository does not know this one exists, so drift stays green there and surfaces here only on the next push (WEB §15 #10) |
| Coordinator cannot use it without a developer | The pilot gate is not met, and it is not met *late* | Pilot | §5's literal test, run early enough that wording defects can still be fixed |
| Console operators are also translators on the same GoTrue instance | An operator's own `must_change_password` state is irrelevant to console access and could confuse a support conversation | Pilot | Documented in WEB §5.2: console access does not use the operator's JWT at all |

---

## 9. Unowned and Open

**This repository has no owner, no CI, and no deployment.** The DB roadmap §8 said the console
was the highest-value thing that could happen during M0, and what has happened since is that
code now exists. That closes the largest part of the gap and does not close the ownership
question — the code needs somebody to verify it, deploy it, hold its key, and answer for it
during a pilot.

The three things that need a name against them:

1. Who reads a red build. CI runs the verification on every change, which answers "who types
   the commands" and not "who sees it fail at 9am and decides whether the console or the
   database is wrong". The schema guard makes that question sharper, not softer: when
   `scripture-bridge-db` renames a column, this repository goes red for a change nobody here
   made.
2. Who holds the service key and rotates it (§4.1 #1).
3. Who the coordinator is in §5's pilot-gate test, and when they are available. They are not a
   developer, so their time has to be asked for rather than assumed.

---

## 10. Ways of Working

- **Every write goes through an `api.*` function** (WEB R-CONN-WEB-8). A rule reimplemented in
  the console is a rule that can drift out of agreement with the database, and the failure is
  silent on a device rather than loud on screen.
- **Console-level policy is written down** (WEB §7). Three rules are enforced here and not in the
  schema; a fourth added without a note in §7 is a bug waiting to be reported.
- **The requirements document is amended in place**, not in a side channel — the same rule the
  other two repositories follow.
- **No secret is committed**, and the bundle check runs before any change is called done, by
  hand until CI exists.
- **`scripture-bridge-db` is not edited from here.** Where the console needs a database change,
  it is proposed in `docs/architecture.md` and landed on that repository's migration timeline,
  with its CI guards run against it.

---

## 11. Sizing

Relative sizes are given per milestone. Absolute duration needs the team shape, which is open in
the DB roadmap §9 and narrower here:

- Is the console owned by the backend engineer, or by someone else? It is a web application with
  a database connection, and those are different skills from RLS and migrations.
- Is there a coordinator available for §5's test before the pilot, or does the pilot itself
  become the test? The second is cheaper to schedule and much more expensive to be wrong about.
- If the pilot date is externally fixed — a translation workshop, a partner commitment — scope
  moves, not the milestone order. M5's export and font upload are where scope is cut from. **M4's
  verification is never where scope is cut from**, because an unverified console fails in front
  of the person it was built for.
