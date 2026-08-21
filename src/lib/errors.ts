import 'server-only';

/**
 * The error model of DB §11.2, seen from the console.
 *
 * Every exception the backend raises carries `ERRCODE = 'PT<status>'`,
 * `MESSAGE = '<code>'`, and `DETAIL` as a JSON object (DB R-ERR-1). Over
 * PostgREST the app's client normalises that into an envelope; over a direct
 * connection it arrives as a node-postgres error with the same three fields, so
 * the normalisation is the same work in a different place.
 *
 * The point of doing it at all: `invalid_transition` and `not_a_project_member`
 * are things a coordinator can act on, and "error: PT409" is not.
 */

export interface ConsoleErrorShape {
  code: string;
  status: number;
  details: Record<string, unknown> | null;
  message: string;
}

export class ConsoleError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | null;

  constructor(shape: ConsoleErrorShape) {
    super(shape.message);
    this.name = 'ConsoleError';
    this.code = shape.code;
    this.status = shape.status;
    this.details = shape.details;
  }
}

/**
 * Human sentences for the codes a console operator can actually provoke.
 * Codes belonging to the translator's write path (`chapter_locked`,
 * `text_not_normalized`, the idempotency pair) are omitted rather than
 * guessed at: the console never calls those RPCs, and an invented message for
 * an error that cannot occur here is worse than the raw code.
 */
const MESSAGES: Record<string, string> = {
  not_found: 'That record does not exist, or it has been archived.',
  invalid_argument: 'One of the values submitted is not allowed.',
  invalid_transition: 'That chapter is not in a state this action can be applied to.',
  versification_missing:
    'The versification scheme has no verse counts for that book, so it cannot be added. ' +
    'Only the "eng" scheme is seeded; "org" is registered but empty (DB R-DATA-2).',
  forbidden: 'The database refused this operation for the current role.',
  append_only_table: 'That table is append-only and cannot be modified.',
};

/** node-postgres surfaces the server fields on the error object itself. */
interface PgErrorLike {
  code?: unknown;
  message?: unknown;
  detail?: unknown;
}

function parseDetail(detail: unknown): Record<string, unknown> | null {
  if (typeof detail !== 'string' || detail.trim() === '') return null;
  try {
    const parsed: unknown = JSON.parse(detail);
    return parsed !== null && typeof parsed === 'object'
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * Turns anything thrown by the data layer into a ConsoleError.
 *
 * An error that is not a `PT<nnn>` exception is a bug, an outage, or a
 * misconfiguration, and it is reported as such rather than being dressed up as
 * a typed application error. The raw message is preserved, because the person
 * reading it is an operator who can act on "connection refused".
 */
export function toConsoleError(err: unknown): ConsoleError {
  if (err instanceof ConsoleError) return err;

  const pg = err as PgErrorLike;
  const sqlstate = typeof pg?.code === 'string' ? pg.code : '';

  if (/^PT\d{3}$/.test(sqlstate)) {
    const code = typeof pg.message === 'string' ? pg.message : 'unknown';
    const details = parseDetail(pg.detail);
    let message = MESSAGES[code] ?? `The database refused this operation (${code}).`;

    // `invalid_argument` carries the offending field, and naming it is the
    // difference between a usable message and a shrug.
    if (code === 'invalid_argument' && typeof details?.field === 'string') {
      message = `Not a valid value for ${details.field}.`;
    }
    if (code === 'invalid_argument' && details?.reason === 'not_a_project_member') {
      message = 'That person is not a member of this project. Add them first, then assign.';
    }

    return new ConsoleError({
      code,
      status: Number(sqlstate.slice(2)),
      details,
      message,
    });
  }

  const raw = err instanceof Error ? err.message : String(err);
  return new ConsoleError({
    code: 'internal_error',
    status: 500,
    details: null,
    message: raw || 'The operation failed for an unknown reason.',
  });
}

/** The shape a Server Action hands back to a form. */
export interface ActionResult {
  ok: boolean;
  message: string;
  code?: string;
}

export function failure(err: unknown): ActionResult {
  const e = toConsoleError(err);
  return { ok: false, message: e.message, code: e.code };
}

export function success(message: string): ActionResult {
  return { ok: true, message };
}
