import 'server-only';
import { query, queryOne } from './db';

/**
 * Every read the console performs.
 *
 * Progress figures come from the maintained counters on `app.chapter`, never
 * from aggregating verse rows (DB R-PERF-1). A whole-Bible project is ~31,000
 * verses; summing them for a dashboard is the kind of query that finds the
 * statement timeout in the field and not in review.
 *
 * `display_name` is nullable and `auth_user_id` is dropped to null by erasure
 * (DB R-DATA-4), so every projection of a person tolerates both. A tombstoned
 * profile still owns revisions and approvals and must keep rendering.
 */

export interface ProjectRow {
  id: string;
  name: string;
  language_name: string;
  language_code: string;
  script_code: string;
  text_direction: 'ltr' | 'rtl';
  versification_scheme: string;
  book_count: number;
  member_count: number;
  chapter_count: number;
  chapters_approved: number;
  chapters_in_review: number;
  chapters_in_progress: number;
  chapters_not_started: number;
  verse_count: number;
  verses_done: number;
  verses_draft: number;
  verses_empty: number;
  verses_flagged: number;
}

const PROJECT_SELECT = `
  select p.id,
         p.name,
         p.language_name,
         p.language_code,
         p.script_code,
         p.text_direction,
         p.versification_scheme,
         (select count(*)::int from app.book b where b.project_id = p.id)           as book_count,
         (select count(*)::int from app.project_member m where m.project_id = p.id) as member_count,
         coalesce(c.chapter_count, 0)         as chapter_count,
         coalesce(c.chapters_approved, 0)     as chapters_approved,
         coalesce(c.chapters_in_review, 0)    as chapters_in_review,
         coalesce(c.chapters_in_progress, 0)  as chapters_in_progress,
         coalesce(c.chapters_not_started, 0)  as chapters_not_started,
         coalesce(c.verse_count, 0)           as verse_count,
         coalesce(c.verses_done, 0)           as verses_done,
         coalesce(c.verses_draft, 0)          as verses_draft,
         coalesce(c.verses_empty, 0)          as verses_empty,
         coalesce(c.verses_flagged, 0)        as verses_flagged
    from app.project p
    left join lateral (
      select count(*)::int                                                  as chapter_count,
             count(*) filter (where ch.workflow_state = 'approved')::int    as chapters_approved,
             count(*) filter (where ch.workflow_state = 'in_review')::int   as chapters_in_review,
             count(*) filter (where ch.workflow_state = 'in_progress')::int as chapters_in_progress,
             count(*) filter (where ch.workflow_state = 'not_started')::int as chapters_not_started,
             coalesce(sum(ch.verse_count), 0)::int                          as verse_count,
             coalesce(sum(ch.verses_done), 0)::int                          as verses_done,
             coalesce(sum(ch.verses_draft), 0)::int                         as verses_draft,
             coalesce(sum(ch.verses_empty), 0)::int                         as verses_empty,
             coalesce(sum(ch.verses_flagged), 0)::int                       as verses_flagged
        from app.chapter ch
       where ch.project_id = p.id
    ) c on true
   where p.archived_at is null`;

export function listProjects(): Promise<ProjectRow[]> {
  return query<ProjectRow>(`${PROJECT_SELECT} order by p.name`);
}

export function getProject(id: string): Promise<ProjectRow | null> {
  return queryOne<ProjectRow>(`${PROJECT_SELECT} and p.id = $1`, [id]);
}

export interface BookRow {
  id: string;
  code: string;
  name: string;
  sort_order: number;
  chapter_count: number;
  verse_count: number;
  verses_done: number;
  verses_flagged: number;
  chapters_approved: number;
  chapters_assigned: number;
}

export function listBooks(projectId: string): Promise<BookRow[]> {
  return query<BookRow>(
    `select b.id, b.code, b.name, b.sort_order, b.chapter_count,
            coalesce(sum(c.verse_count), 0)::int    as verse_count,
            coalesce(sum(c.verses_done), 0)::int    as verses_done,
            coalesce(sum(c.verses_flagged), 0)::int as verses_flagged,
            count(c.id) filter (where c.workflow_state = 'approved')::int       as chapters_approved,
            count(c.id) filter (where c.assigned_translator_id is not null)::int as chapters_assigned
       from app.book b
       left join app.chapter c on c.book_id = b.id
      where b.project_id = $1
      group by b.id, b.code, b.name, b.sort_order, b.chapter_count
      order by b.sort_order`,
    [projectId],
  );
}

export type WorkflowState = 'not_started' | 'in_progress' | 'in_review' | 'approved';

export interface ChapterRow {
  id: string;
  book_id: string;
  book_code: string;
  number: number;
  verse_count: number;
  workflow_state: WorkflowState;
  assigned_translator_id: string | null;
  assigned_translator_name: string | null;
  assigned_reviewer_id: string | null;
  assigned_reviewer_name: string | null;
  submitted_at: string | null;
  approved_at: string | null;
  verses_done: number;
  verses_draft: number;
  verses_empty: number;
  verses_flagged: number;
}

export function listChapters(bookId: string): Promise<ChapterRow[]> {
  return query<ChapterRow>(
    `select c.id, c.book_id, b.code as book_code, c.number, c.verse_count,
            c.workflow_state,
            c.assigned_translator_id, tr.display_name as assigned_translator_name,
            c.assigned_reviewer_id,   rv.display_name as assigned_reviewer_name,
            c.submitted_at, c.approved_at,
            c.verses_done, c.verses_draft, c.verses_empty, c.verses_flagged
       from app.chapter c
       join app.book b on b.id = c.book_id
       left join app.profile tr on tr.id = c.assigned_translator_id
       left join app.profile rv on rv.id = c.assigned_reviewer_id
      where c.book_id = $1
      order by c.number`,
    [bookId],
  );
}

export interface MemberRow {
  profile_id: string;
  display_name: string | null;
  email: string | null;
  role: 'admin' | 'translator' | 'reviewer';
  must_change_password: boolean;
  anonymised: boolean;
  assigned_chapters: number;
}

export function listMembers(projectId: string): Promise<MemberRow[]> {
  return query<MemberRow>(
    `select m.profile_id,
            pf.display_name,
            u.email,
            m.role,
            pf.must_change_password,
            pf.anonymised_at is not null as anonymised,
            (select count(*)::int from app.chapter c
              where c.project_id = m.project_id
                and (c.assigned_translator_id = m.profile_id
                     or c.assigned_reviewer_id = m.profile_id)) as assigned_chapters
       from app.project_member m
       join app.profile pf on pf.id = m.profile_id
       left join auth.users u on u.id = pf.auth_user_id
      where m.project_id = $1
      order by m.role, coalesce(pf.display_name, u.email, m.profile_id::text)`,
    [projectId],
  );
}

export interface AccountRow {
  profile_id: string;
  auth_user_id: string | null;
  display_name: string | null;
  email: string | null;
  must_change_password: boolean;
  anonymised: boolean;
  created_at: string;
  last_sign_in_at: string | null;
  project_count: number;
}

export function listAccounts(): Promise<AccountRow[]> {
  return query<AccountRow>(
    `select pf.id as profile_id,
            pf.auth_user_id,
            pf.display_name,
            u.email,
            pf.must_change_password,
            pf.anonymised_at is not null as anonymised,
            pf.created_at,
            u.last_sign_in_at,
            (select count(*)::int from app.project_member m where m.profile_id = pf.id) as project_count
       from app.profile pf
       left join auth.users u on u.id = pf.auth_user_id
      order by coalesce(pf.display_name, u.email, pf.id::text)`,
  );
}

export function getAccount(profileId: string): Promise<AccountRow | null> {
  return queryOne<AccountRow>(
    `select pf.id as profile_id, pf.auth_user_id, pf.display_name, u.email,
            pf.must_change_password, pf.anonymised_at is not null as anonymised,
            pf.created_at, u.last_sign_in_at,
            (select count(*)::int from app.project_member m where m.profile_id = pf.id) as project_count
       from app.profile pf
       left join auth.users u on u.id = pf.auth_user_id
      where pf.id = $1`,
    [profileId],
  );
}

/** The profile the trigger created for a freshly provisioned auth user (R-AUTH-DB-6). */
export function profileForAuthUser(authUserId: string): Promise<{ id: string } | null> {
  return queryOne<{ id: string }>(
    `select id from app.profile where auth_user_id = $1`,
    [authUserId],
  );
}

export interface AuditRow {
  id: string;
  occurred_at: string;
  actor_kind: 'user' | 'console' | 'system';
  actor_label: string | null;
  actor_name: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  before: unknown;
  after: unknown;
}

/**
 * The audit trail (DB §12.2, R-AUTH-DB-12).
 *
 * Append-only at the table level, so this is read-only by construction — there
 * is no console path that could edit it even by mistake.
 */
export function listAudit(opts: {
  limit: number;
  offset: number;
  action?: string | undefined;
  targetId?: string | undefined;
}): Promise<AuditRow[]> {
  return query<AuditRow>(
    `select a.id, a.occurred_at, a.actor_kind, a.actor_label,
            pf.display_name as actor_name,
            a.action, a.target_type, a.target_id, a.before, a.after
       from app.audit_log a
       left join app.profile pf on pf.id = a.actor_profile_id
      where ($3::text is null or a.action = $3)
        and ($4::uuid is null or a.target_id = $4)
      order by a.occurred_at desc
      limit $1 offset $2`,
    [opts.limit, opts.offset, opts.action ?? null, opts.targetId ?? null],
  );
}

export function listAuditActions(): Promise<{ action: string }[]> {
  return query<{ action: string }>(
    `select distinct action from app.audit_log order by action`,
  );
}

export interface SchemeRow {
  code: string;
  name: string;
  /** False for a scheme registered but not seeded — `org` today (DB R-DATA-2). */
  usable: boolean;
}

export function listSchemes(): Promise<SchemeRow[]> {
  return query<SchemeRow>(
    `select s.code, s.name,
            exists (select 1 from ref.versification v where v.scheme_code = s.code) as usable
       from ref.versification_scheme s
      order by s.code`,
  );
}

export interface CanonBookRow {
  code: string;
  name_en: string;
  testament: 'ot' | 'nt';
  sort_order: number;
  chapter_count: number;
  verse_count: number;
}

/**
 * The canon, with the verse total each book would materialise under a scheme.
 *
 * Books with no versification rows are excluded rather than offered and then
 * refused: `create_project` raises `versification_missing` for them, and a
 * dropdown that lists a choice which always fails is a trap.
 */
export function listCanon(scheme: string): Promise<CanonBookRow[]> {
  return query<CanonBookRow>(
    `select bc.code, bc.name_en, bc.testament, bc.sort_order,
            count(v.chapter_number)::int as chapter_count,
            coalesce(sum(v.verse_count), 0)::int as verse_count
       from ref.book_canon bc
       join ref.versification v
         on v.book_code = bc.code and v.scheme_code = $1
      group by bc.code, bc.name_en, bc.testament, bc.sort_order
      order by bc.sort_order`,
    [scheme],
  );
}

export interface DashboardStats {
  project_count: number;
  account_count: number;
  accounts_pending_password: number;
  chapters_in_review: number;
  chapters_flagged: number;
  unassigned_chapters: number;
}

export function dashboardStats(): Promise<DashboardStats | null> {
  return queryOne<DashboardStats>(
    `select (select count(*)::int from app.project where archived_at is null) as project_count,
            (select count(*)::int from app.profile where anonymised_at is null) as account_count,
            (select count(*)::int from app.profile
              where must_change_password and anonymised_at is null) as accounts_pending_password,
            (select count(*)::int from app.chapter where workflow_state = 'in_review') as chapters_in_review,
            (select count(*)::int from app.chapter where verses_flagged > 0) as chapters_flagged,
            (select count(*)::int from app.chapter
              where assigned_translator_id is null
                and workflow_state <> 'approved') as unassigned_chapters`,
  );
}
