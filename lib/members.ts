/** Browser reader for the public, aggregate-only Identity member count. */

const ENDPOINT = '/.netlify/functions/member-count';

interface MemberCountResponse {
  registeredMembers?: unknown;
}

/** Return the confirmed-account count, or null when the service is unavailable. */
export async function readMemberCount(): Promise<number | null> {
  try {
    const response = await fetch(ENDPOINT, { cache: 'no-store' });
    if (!response.ok) return null;
    const body = (await response.json()) as MemberCountResponse;
    return typeof body.registeredMembers === 'number' &&
      Number.isSafeInteger(body.registeredMembers) &&
      body.registeredMembers >= 0
      ? body.registeredMembers
      : null;
  } catch {
    return null;
  }
}
