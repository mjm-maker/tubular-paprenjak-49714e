import { sql } from 'drizzle-orm';
import { visitors } from '@/db/schema';

/**
 * Visitor counter.
 *
 * GET  → the current totals.
 * POST → records one visit for the anonymous id in the body, then returns the totals.
 *
 * The only thing stored is the random id the browser keeps in localStorage plus two
 * timestamps, so a returning visitor increments their own row instead of adding a new
 * one. Nothing here identifies a person: no IP, no user agent, no headers are read.
 *
 * Every failure answers 503 with a small JSON body. The footer hides the counter when
 * that happens rather than showing an error, so a database hiccup never reaches the UI.
 */

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Matches the ids `lib/visitors.ts` generates (UUID v4, hex, or the timestamp fallback). */
const VISITOR_ID = /^[0-9a-z-]{8,64}$/i;

interface Counts {
  totalVisits: number;
  uniqueVisitors: number;
}

/**
 * The Drizzle client is loaded lazily: `drizzle()` throws when the Netlify database
 * environment variable is absent, and that must degrade into a 503 at request time
 * rather than breaking the build or a plain `next dev` session.
 */
async function connect() {
  const module = await import('@/db');
  return module.db;
}

async function readCounts(db: Awaited<ReturnType<typeof connect>>): Promise<Counts> {
  const [row] = await db
    .select({
      // sum() and count() come back as strings from Postgres, hence the coercion.
      totalVisits: sql<string>`coalesce(sum(${visitors.visits}), 0)`.as('total_visits'),
      uniqueVisitors: sql<string>`count(*)`.as('unique_visitors'),
    })
    .from(visitors);

  return {
    totalVisits: Number(row?.totalVisits ?? 0),
    uniqueVisitors: Number(row?.uniqueVisitors ?? 0),
  };
}

const unavailable = () =>
  Response.json({ error: 'The visitor counter is unavailable.' }, { status: 503 });

export async function GET() {
  try {
    const db = await connect();
    return Response.json(await readCounts(db), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return unavailable();
  }
}

export async function POST(request: Request) {
  let visitorId: unknown;
  try {
    const body: unknown = await request.json();
    visitorId = (body as { visitorId?: unknown } | null)?.visitorId;
  } catch {
    return Response.json({ error: 'Expected a JSON body.' }, { status: 400 });
  }

  if (typeof visitorId !== 'string' || !VISITOR_ID.test(visitorId)) {
    return Response.json({ error: 'Expected a valid visitorId.' }, { status: 400 });
  }

  try {
    const db = await connect();
    // One row per visitor: the first visit inserts it, every later visit bumps the
    // same row, so refreshing can never invent a second unique visitor.
    await db
      .insert(visitors)
      .values({ visitorId })
      .onConflictDoUpdate({
        target: visitors.visitorId,
        set: { visits: sql`${visitors.visits} + 1`, lastSeenAt: new Date() },
      });

    return Response.json(await readCounts(db), {
      headers: { 'cache-control': 'no-store' },
    });
  } catch {
    return unavailable();
  }
}
