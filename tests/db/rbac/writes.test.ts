// tests/db/rbac/writes.test.ts
// @vitest-environment node
// Every role tries to insert, update and delete probe rows in every base table, at branch A and at
// branch B; what is allowed must match the matrix.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WRITES, type WriteEntry } from './tables';
import { ROLES, effective, type Role, type WriteScope } from './types';
import {
  cleanupRbacFixture,
  createRbacFixture,
  loose,
  runUndo,
  type At,
  type Loose,
  type RbacFixture,
} from './fixture';

let f: RbacFixture;
beforeAll(async () => {
  f = await createRbacFixture();
}, 180000);
afterAll(async () => {
  await cleanupRbacFixture(f);
}, 180000);

const OPS = ['insert', 'update', 'delete'] as const;
type Op = (typeof OPS)[number];
const SIDES: At[] = ['a', 'b'];

/** Whether the matrix says `role` may write at branch `at` under this scope. */
function shouldAllow(scope: WriteScope, role: Role, at: At): boolean {
  switch (scope) {
    case 'deny':
      return false;
    case 'all':
      return true;
    case 'own':
      return at === 'a';
    case 'branch':
      return at === (role === 'otherManager' ? 'b' : 'a');
  }
}

/** A permission refusal comes back as an error or as zero affected rows. Anything that says the probe
 * itself is wrong (bad column, constraint violation) is a test bug, not a refusal. */
function refusal(
  error: { code?: string; message: string } | null,
  what: string,
  passCodes: string[] = [],
): boolean {
  if (!error) return false;
  const code = error.code ?? '';
  if (passCodes.includes(code)) return false;
  if (code.startsWith('22') || code.startsWith('23') || code === '42703' || code === '42P01') {
    throw new Error(`${what}: the probe row is invalid (${code} ${error.message})`);
  }
  return true;
}

async function count(db: Loose, table: string, match: Record<string, unknown>): Promise<number> {
  const r = await db.from(table).select('*', { count: 'exact', head: true }).match(match);
  if (r.error) throw new Error(`count ${table}: ${r.error.message}`);
  return r.count ?? 0;
}

async function tryInsert(entry: WriteEntry, role: Role, at: At): Promise<boolean> {
  const what = `${entry.table} insert as ${role} at ${at}`;
  const row = await entry.probe.insert!(f, at);
  const r = await (f.clients[role] as unknown as Loose).from(entry.table).insert(row);
  if (r.error && entry.probe.passCodes?.includes(r.error.code ?? '')) return true;
  return !refusal(r.error, what);
}

async function tryUpdate(entry: WriteEntry, role: Role, at: At): Promise<boolean> {
  const what = `${entry.table} update as ${role} at ${at}`;
  const db = loose(f);
  const t = await entry.probe.target(f, at);
  const match = t.match ?? { [entry.key]: t.key };
  const before = await db.from(entry.table).select(t.column).match(match);
  if (before.error || !before.data || before.data.length !== 1) {
    throw new Error(`${what}: probe row not found (${before.error?.message ?? 'no row'})`);
  }
  const original = (before.data[0] as unknown as Record<string, unknown>)[t.column];
  const r = await (f.clients[role] as unknown as Loose)
    .from(entry.table)
    .update({ [t.column]: t.value })
    .match(match);
  if (refusal(r.error, what)) return false;
  const after = { ...match, [t.column]: t.value };
  const allowed = (await count(db, entry.table, after)) === 1;
  if (allowed) {
    // Put back whatever a shared fixture row held before.
    const back = await db
      .from(entry.table)
      .update({ [t.column]: original })
      .match(after);
    if (back.error) throw new Error(`${what}: restore failed: ${back.error.message}`);
  }
  return allowed;
}

async function tryDelete(entry: WriteEntry, role: Role, at: At): Promise<boolean> {
  const what = `${entry.table} delete as ${role} at ${at}`;
  const db = loose(f);
  const t = await (entry.probe.deleteTarget ?? entry.probe.target)(f, at);
  const match = t.match ?? { [entry.key]: t.key };
  if ((await count(db, entry.table, match)) !== 1) throw new Error(`${what}: probe row not found`);
  const r = await (f.clients[role] as unknown as Loose).from(entry.table).delete().match(match);
  if (r.error && entry.probe.passCodes?.includes(r.error.code ?? '')) return true;
  if (refusal(r.error, what)) return false;
  return (await count(db, entry.table, match)) === 0;
}

const attempt = { insert: tryInsert, update: tryUpdate, delete: tryDelete } satisfies Record<
  Op,
  (entry: WriteEntry, role: Role, at: At) => Promise<boolean>
>;

describe.each(WRITES)('$table', (entry) => {
  it.each(ROLES)(
    '%s',
    async (role) => {
      for (const op of OPS) {
        const scope = effective(entry[op][role]);
        if (op === 'insert' && !entry.probe.insert) {
          expect(
            scope,
            `${entry.table} insert as ${role}: no insert probe, so it must be deny`,
          ).toBe('deny');
          const r = await (f.clients[role] as unknown as Loose).from(entry.table).insert({});
          expect(r.error, `${entry.table} plain insert as ${role}`).not.toBeNull();
          continue;
        }
        for (const at of SIDES) {
          let allowed: boolean;
          try {
            allowed = await attempt[op](entry, role, at);
          } finally {
            await runUndo(f);
          }
          expect
            .soft(allowed, `${entry.table} ${op} as ${role} at ${at}`)
            .toBe(shouldAllow(scope, role, at));
        }
      }
    },
    240000,
  );
});
