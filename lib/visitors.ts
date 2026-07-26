/**
 * Visitor counter, browser half.
 *
 * The id is random and lives in localStorage, so the same browser stays the same
 * unique visitor across refreshes, deploys and days. A "visit" is one browsing
 * session: the first load in a tab session records a visit, later refreshes in that
 * session only read the totals back. Nothing about the person is sent — just the id.
 *
 * Every path here swallows its own errors and resolves to `null`, which is the signal
 * the footer uses to hide the counter instead of surfacing a failure.
 */

export interface VisitorCounts {
  totalVisits: number;
  uniqueVisitors: number;
}

const ID_KEY = 'glasko.visitor-id';
const SESSION_KEY = 'glasko.visit-counted';
const ENDPOINT = '/api/visitors';

/** Must stay in step with the pattern the API route validates against. */
const ID_PATTERN = /^[0-9a-z-]{8,64}$/i;

function randomId(): string {
  const source = globalThis.crypto;
  if (source?.randomUUID) return source.randomUUID();
  if (source?.getRandomValues) {
    const bytes = new Uint8Array(16);
    source.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The stored id, creating one on first visit.
 *
 * Storage can throw outright (Safari private browsing, cookies blocked). In that case
 * the visit still counts, but the browser cannot be recognised next time — an accepted
 * trade rather than a reason to lose the visit.
 */
export function getVisitorId(): string {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(ID_KEY);
  } catch {
    stored = null;
  }
  if (stored && ID_PATTERN.test(stored)) return stored;

  const fresh = randomId();
  try {
    window.localStorage.setItem(ID_KEY, fresh);
  } catch {
    // Ignore: a non-persisted id is still a valid one-off visit.
  }
  return fresh;
}

function countedThisSession(): boolean {
  try {
    return window.sessionStorage.getItem(SESSION_KEY) === '1';
  } catch {
    return false;
  }
}

function markCountedThisSession(): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY, '1');
  } catch {
    // Ignore: at worst a refresh records a second visit for the same visitor.
  }
}

function parseCounts(value: unknown): VisitorCounts | null {
  const counts = value as Partial<VisitorCounts> | null;
  if (
    !counts ||
    typeof counts.totalVisits !== 'number' ||
    typeof counts.uniqueVisitors !== 'number' ||
    !Number.isFinite(counts.totalVisits) ||
    !Number.isFinite(counts.uniqueVisitors)
  ) {
    return null;
  }
  return { totalVisits: counts.totalVisits, uniqueVisitors: counts.uniqueVisitors };
}

/**
 * Record this visit (once per tab session) and return the live totals, or `null` if
 * the counter is unreachable.
 */
async function sendVisit(): Promise<VisitorCounts | null> {
  const alreadyCounted = countedThisSession();
  try {
    const response = alreadyCounted
      ? await fetch(ENDPOINT, { cache: 'no-store' })
      : await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ visitorId: getVisitorId() }),
          cache: 'no-store',
        });

    if (!response.ok) return null;
    const counts = parseCounts(await response.json());
    // Only claim the session once the write actually landed, so a failed request is
    // retried on the next load instead of being silently dropped.
    if (counts && !alreadyCounted) markCountedThisSession();
    return counts;
  } catch {
    return null;
  }
}

let pending: Promise<VisitorCounts | null> | null = null;

/**
 * Record this visit and return the live totals, or `null` when the counter cannot be
 * reached. Never rejects.
 *
 * Concurrent calls share one request: React mounts a component twice under strict mode,
 * and a visit is one visit however many times the effect runs. The request is
 * deliberately not abortable — cancelling a POST that already reached the server would
 * lose the response while still counting the visit.
 */
export function recordVisit(): Promise<VisitorCounts | null> {
  if (!pending) {
    const request = sendVisit();
    pending = request;
    void request.then(
      () => {
        pending = null;
      },
      () => {
        pending = null;
      },
    );
  }
  return pending;
}
