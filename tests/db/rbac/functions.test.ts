// tests/db/rbac/functions.test.ts
// @vitest-environment node
// Every role calls every client-callable function; what is allowed, refused or empty must match the
// matrix.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUNCTIONS, drainScratch, type FunctionEntry } from './functions';
import { ROLES, effective, type Outcome } from './types';
import { cleanupRbacFixture, createRbacFixture, type Loose, type RbacFixture } from './fixture';

let f: RbacFixture;
beforeAll(async () => {
  f = await createRbacFixture();
}, 180000);
afterAll(async () => {
  let failure: unknown;
  try {
    await drainScratch();
  } catch (e) {
    failure = e;
  }
  try {
    await cleanupRbacFixture(f);
  } catch (e) {
    failure = failure ? new Error(`${msg(failure)}\nand the fixture cleanup failed: ${msg(e)}`) : e;
  }
  if (failure) throw failure;
}, 180000);

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** A refusal is an exception the function raised (P0001) or a permission error (42501). Anything
 * else (network, JWT, server, bad arguments) means the call itself broke and must never read as a
 * refusal. */
const REFUSAL_CODES = ['P0001', '42501'];

function isEmpty(data: unknown): boolean {
  if (data === null || data === undefined || data === 0) return true;
  if (Array.isArray(data)) return data.length === 0;
  if (typeof data === 'object') return Object.keys(data).length === 0;
  return false;
}

async function observe(entry: FunctionEntry, role: (typeof ROLES)[number]) {
  const what = `${entry.name} as ${role}`;
  const args = await entry.args(f, role);
  const { data, error } = await (f.clients[role] as unknown as Loose).rpc(entry.name, args);
  if (error) {
    if (!REFUSAL_CODES.includes(error.code ?? '')) {
      throw new Error(`${what}: unexpected error (${error.code || 'no code'}) ${error.message}`);
    }
    return { actual: 'deny' as Outcome, note: ` (${error.message})` };
  }
  if (entry.void) {
    const took = entry.applied ? await entry.applied(f, args) : true;
    return { actual: (took ? 'allow' : 'empty') as Outcome, note: '' };
  }
  return { actual: (isEmpty(data) ? 'empty' : 'allow') as Outcome, note: '' };
}

describe.each(FUNCTIONS.map((entry) => [entry.name, entry] as const))('%s', (_name, entry) => {
  afterAll(async () => {
    await drainScratch(entry.name);
  }, 180000);

  it.each(ROLES)(
    '%s',
    async (role) => {
      const wanted = effective(entry.outcome[role]);
      if (wanted === 'internal') return;
      const { actual, note } = await observe(entry, role);
      expect(actual, `${entry.name} as ${role}${note}`).toBe(wanted);
    },
    120000,
  );
});
