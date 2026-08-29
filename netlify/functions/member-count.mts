import { admin } from '@netlify/identity';
import { countConfirmedMembers } from '../../lib/member-count';

const PAGE_SIZE = 100;
const MAX_PAGES = 1_000;

/**
 * Public aggregate count backed by Identity's server-only admin API.
 *
 * The operator token is supplied by the Netlify Functions runtime and never leaves
 * this function. No name, email, phone or user id is returned — only the number of
 * email-confirmed accounts. Pending signups do not inflate the public total.
 */
export default async function memberCount(request: Request): Promise<Response> {
  if (request.method !== 'GET') {
    return Response.json({ error: 'Method not allowed.' }, { status: 405 });
  }

  try {
    const registeredMembers = await countConfirmedMembers(
      (options) => admin.listUsers(options),
      PAGE_SIZE,
      MAX_PAGES,
    );
    return Response.json(
      { registeredMembers },
      {
        headers: {
          'cache-control': 'public, max-age=30, s-maxage=60',
          'content-type': 'application/json; charset=utf-8',
        },
      },
    );
  } catch {
    return Response.json({ error: 'The member count is unavailable.' }, { status: 503 });
  }
}
