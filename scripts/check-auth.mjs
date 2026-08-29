/** Account gate checks — `npm run auth:check`. */

import { validateSignup } from '../lib/auth.ts';
import { countConfirmedMembers } from '../lib/member-count.ts';
import { readMemberCount } from '../lib/members.ts';

let checks = 0;
let failures = 0;

function ok(condition, label) {
  checks++;
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.log(`  FAIL ${label}`);
  }
}

console.log('GLASKO required-account checks');

const minimal = validateSignup({
  name: 'Dimitar Stankov',
  email: 'dimitar@example.com',
  phone: '',
  password: 'glasko123',
  confirm: 'glasko123',
});
ok(Object.keys(minimal).length === 0, 'name and unique email can register without a phone');

const withPhone = validateSignup({
  name: 'Dimitar Stankov',
  email: 'dimitar@example.com',
  phone: '+357 99 123 456',
  password: 'glasko123',
  confirm: 'glasko123',
});
ok(Object.keys(withPhone).length === 0, 'an international optional phone is accepted');

const invalid = validateSignup({
  name: '',
  email: 'not-an-email',
  phone: 'call me',
  password: 'short',
  confirm: 'different',
});
ok(Boolean(invalid.name), 'missing name is rejected');
ok(Boolean(invalid.email), 'invalid email is rejected');
ok(Boolean(invalid.phone), 'invalid optional phone is rejected when supplied');
ok(Boolean(invalid.password), 'weak password is rejected');

const pageCalls = [];
const confirmed = await countConfirmedMembers(
  async ({ page, perPage }) => {
    pageCalls.push({ page, perPage });
    if (page === 1) return [{ confirmedAt: '2026-08-01' }, {}];
    return [{ confirmedAt: '2026-08-02' }];
  },
  2,
  5,
);
ok(confirmed === 2, 'only email-confirmed Identity accounts enter the total');
ok(pageCalls.length === 2 && pageCalls[1].page === 2, 'the complete Identity set is paginated');

const originalFetch = globalThis.fetch;
globalThis.fetch = async () =>
  new Response(JSON.stringify({ registeredMembers: 12 }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
ok((await readMemberCount()) === 12, 'the browser accepts a valid aggregate count');
globalThis.fetch = async () => new Response(JSON.stringify({ registeredMembers: '12' }));
ok((await readMemberCount()) === null, 'the browser hides a malformed count');
globalThis.fetch = originalFetch;

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) process.exitCode = 1;
