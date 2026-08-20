import 'server-only';

/**
 * A small fixed-window limiter for the sign-in form.
 *
 * GoTrue rate-limits its own auth endpoints (DB R-API-DB-4), but those limits
 * are tuned for a cohort signing in at once and are not a brute-force control
 * for a console that can create accounts and reset passwords. This adds a
 * per-identifier ceiling in front of that.
 *
 * In-process and therefore per-instance. That is honest for a console, which is
 * a single low-traffic deployment; if it is ever run behind more than one
 * replica this needs to move to shared storage, and the comment is here so that
 * is a decision rather than a discovery.
 */

interface Window {
  count: number;
  resetAt: number;
}

const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

declare global {
  // eslint-disable-next-line no-var
  var __sbConsoleAttempts: Map<string, Window> | undefined;
}

function store(): Map<string, Window> {
  globalThis.__sbConsoleAttempts ??= new Map();
  return globalThis.__sbConsoleAttempts;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export function checkRateLimit(key: string): RateLimitResult {
  const now = Date.now();
  const map = store();

  // Opportunistic sweep. The map is bounded by the number of distinct
  // identifiers tried in a window, which for a console is small, but an
  // unbounded map fed by attacker-chosen keys is a slow leak.
  if (map.size > 1000) {
    for (const [k, w] of map) if (w.resetAt <= now) map.delete(k);
  }

  const existing = map.get(key);
  if (!existing || existing.resetAt <= now) {
    map.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  existing.count += 1;
  if (existing.count > MAX_ATTEMPTS) {
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil((existing.resetAt - now) / 1000),
    };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Called after a successful sign-in so a correct password clears the count. */
export function clearRateLimit(key: string): void {
  store().delete(key);
}
