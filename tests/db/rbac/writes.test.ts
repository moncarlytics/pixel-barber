// tests/db/rbac/writes.test.ts
// @vitest-environment node
// Every role tries to insert, update and delete probe rows in every base table, at branch A and at
// branch B; what is allowed must match the matrix.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WRITES, type WriteEntry, type WriteTarget } from './tables';
import { ROLES, effective, type Role, type WriteScope } from './types';
import {
  buildScoped,
  cleanupRbacFixture,
  createRbacFixture,
  loose,
  runStack,
  runUndo,
  track,
  type At,
  type Loose,
  type RbacFixture,
} from './fixture';

let f: RbacFixture;
beforeAll(async () => {
  f = await createRbacFixture();
}, 180000);
afterAll(async () => {
  let failure: unknown;
  try {
    await disposeAll();
  } catch (e) {
    failure = e;
  }
  try {
    await cleanupRbacFixture(f);
  } catch (e) {
    failure = failure
      ? new Error(`${msg(failure)}
and the fixture cleanup failed: ${msg(e)}`)
      : e;
  }
  if (failure) throw failure;
}, 180000);

const OPS = ['insert', 'update', 'delete'] as const;
type Op = (typeof OPS)[number];
/** 'a-other' is a branch-A row owned by someone else; it is tried only for cells whose scope is
 * `own`, and must always be refused. */
type Side = At | 'a-other';
const SIDES: Side[] = ['a', 'b', 'a-other'];

/** Whether the matrix says `role` may write at this side under this scope. */
function shouldAllow(scope: WriteScope, role: Role, at: Side): boolean {
  if (at === 'a-other') return scope === 'all' || scope === 'branch';
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

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Probe rows are built once per (entry, operation, branch) and reused by the next role until a
 * write was allowed (which consumes or changes them). */
type Undo = () => Promise<void>;
const cache = new Map<string, { value: unknown; undo: Undo[] }>();
const nameOf = (entry: WriteEntry) => entry.label ?? entry.table;

async function dispose(key: string): Promise<void> {
  const c = cache.get(key);
  if (!c) return;
  cache.delete(key);
  await runStack(c.undo);
}

async function disposeEntry(entry: WriteEntry): Promise<void> {
  let first: unknown;
  for (const key of [...cache.keys()].filter((k) => k.startsWith(`${nameOf(entry)}|`))) {
    await dispose(key).catch((e) => (first ??= e));
  }
  if (first) throw first;
}

async function disposeAll(): Promise<void> {
  let first: unknown;
  for (const key of [...cache.keys()]) await dispose(key).catch((e) => (first ??= e));
  if (first) throw first;
}

async function cached<T>(
  entry: WriteEntry,
  kind: Op,
  at: Side,
  build: () => Promise<T>,
): Promise<{ key: string; value: T }> {
  if (entry.probe.exclusive) {
    for (const other of OPS.filter((o) => o !== kind)) {
      for (const side of SIDES) await dispose(`${nameOf(entry)}|${other}|${side}`);
    }
  }
  const key = `${nameOf(entry)}|${kind}|${at}`;
  let c = cache.get(key);
  if (!c) {
    const built = await buildScoped(f, build);
    c = { value: built.value, undo: built.undo };
    cache.set(key, c);
  }
  return { key, value: c.value as T };
}

/** 'refused' only for a permission error (42501). Documented constraint stops count as allowed; any
 * other error means the call itself broke, which must never read as a refusal. */
function classify(
  error: { code?: string; message: string } | null,
  what: string,
  passCodes: string[] = [],
  refuseErrors: { code: string; message: string }[] = [],
): 'ok' | 'refused' {
  if (!error) return 'ok';
  const code = error.code ?? '';
  if (
    code === '42501' ||
    refuseErrors.some((x) => x.code === code && error.message.includes(x.message))
  )
    return 'refused';
  if (passCodes.includes(code)) return 'ok';
  throw new Error(`${what}: unexpected error (${code || 'no code'}) ${error.message}`);
}

async function count(db: Loose, table: string, match: Record<string, unknown>): Promise<number> {
  const r = await db.from(table).select('*', { count: 'exact', head: true }).match(match);
  if (r.error) throw new Error(`count ${table}: ${r.error.message}`);
  return r.count ?? 0;
}

const client = (role: Role) => f.clients[role] as unknown as Loose;

/** The probe builders for one side; 'a-other' needs the entry's `other` builders. */
function builder<K extends 'insert' | 'target' | 'deleteTarget'>(
  entry: WriteEntry,
  name: K,
  at: Side,
): () => Promise<K extends 'insert' ? Record<string, unknown> : WriteTarget> {
  type R = K extends 'insert' ? Record<string, unknown> : WriteTarget;
  if (at === 'a-other') {
    const o = entry.probe.other;
    const fn = (o?.[name] ?? (name === 'deleteTarget' ? o?.target : undefined)) as
      ((f: RbacFixture) => Promise<R>) | undefined;
    if (!fn) throw new Error(`${nameOf(entry)}: an own-scope ${name} needs probe.other.${name}`);
    return () => fn(f);
  }
  const p = entry.probe;
  const fn = (name === 'deleteTarget' ? (p.deleteTarget ?? p.target) : p[name]) as (
    f: RbacFixture,
    at: At,
  ) => Promise<R>;
  return () => fn(f, at);
}

async function tryInsert(entry: WriteEntry, role: Role, at: Side): Promise<boolean> {
  const what = `${nameOf(entry)} insert as ${role} at ${at}`;
  const { key, value: row } = await cached(entry, 'insert', at, builder(entry, 'insert', at));
  const r = await client(role).from(entry.table).insert(row);
  if (classify(r.error, what, entry.probe.passCodes, entry.probe.refuseErrors) === 'refused')
    return false;
  // A stored row is gone from the cache so the next role gets a fresh one.
  if (!r.error) await dispose(key);
  return true;
}

async function tryUpdate(entry: WriteEntry, role: Role, at: Side): Promise<boolean> {
  const what = `${nameOf(entry)} update as ${role} at ${at}`;
  const db = loose(f);
  const { key, value: t } = await cached(entry, 'update', at, builder(entry, 'target', at));
  const match = t.match ?? { [entry.key]: t.key };
  const before = await db.from(entry.table).select(t.column).match(match);
  if (before.error || !before.data || before.data.length !== 1) {
    throw new Error(`${what}: probe row not found (${before.error?.message ?? 'no row'})`);
  }
  const original = (before.data[0] as unknown as Record<string, unknown>)[t.column];
  if (JSON.stringify(original) === JSON.stringify(t.value)) {
    throw new Error(`${what}: probe invalid, ${t.column} already equals the new value`);
  }
  const after = { ...match, [t.column]: t.value };
  if ((await count(db, entry.table, after)) !== 0) {
    throw new Error(`${what}: probe invalid, the success row already exists`);
  }
  // Registered before the write, so a shared row is put back whatever happens next.
  track(f, async () => {
    const back = await db
      .from(entry.table)
      .update({ [t.column]: original })
      .match(after);
    if (back.error) throw new Error(`${what}: restore failed: ${back.error.message}`);
  });
  const r = await client(role)
    .from(entry.table)
    .update({ [t.column]: t.value })
    .match(match);
  if (classify(r.error, what, [], entry.probe.refuseErrors) === 'refused') return false;
  const allowed = (await count(db, entry.table, after)) === 1;
  if (allowed) await dispose(key); // the row changed: rebuild for the next role
  return allowed;
}

async function tryDelete(entry: WriteEntry, role: Role, at: Side): Promise<boolean> {
  const what = `${nameOf(entry)} delete as ${role} at ${at}`;
  const db = loose(f);
  const { key, value: t } = await cached(entry, 'delete', at, builder(entry, 'deleteTarget', at));
  const match = t.match ?? { [entry.key]: t.key };
  if ((await count(db, entry.table, match)) !== 1) throw new Error(`${what}: probe row not found`);
  const r = await client(role).from(entry.table).delete().match(match);
  if (classify(r.error, what, entry.probe.passCodes, entry.probe.refuseErrors) === 'refused')
    return false;
  if (r.error) return true; // stopped by a constraint after row security let it through
  const allowed = (await count(db, entry.table, match)) === 0;
  if (allowed) await dispose(key);
  return allowed;
}

const attempt = { insert: tryInsert, update: tryUpdate, delete: tryDelete } satisfies Record<
  Op,
  (entry: WriteEntry, role: Role, at: Side) => Promise<boolean>
>;

/** Runs one attempt, then the undo stack; a failure in either is reported, never swallowed. */
async function guarded(entry: WriteEntry, op: Op, role: Role, at: Side): Promise<boolean> {
  let allowed = false;
  let failure: unknown;
  try {
    allowed = await attempt[op](entry, role, at);
  } catch (e) {
    failure = e;
    try {
      await dispose(`${nameOf(entry)}|${op}|${at}`);
    } catch (d) {
      failure = new Error(`${msg(e)}
and discarding the probe row also failed: ${msg(d)}`);
    }
  }
  try {
    await runUndo(f);
  } catch (e) {
    failure = failure ? new Error(`${msg(failure)}\nand the cleanup also failed: ${msg(e)}`) : e;
  }
  if (failure) throw failure;
  return allowed;
}

describe.each(WRITES.map((entry) => [nameOf(entry), entry] as const))('%s', (_name, entry) => {
  afterAll(async () => {
    await disposeEntry(entry);
  }, 180000);

  it.each(ROLES)(
    '%s',
    async (role) => {
      for (const op of OPS) {
        if (entry.insertOnly && op !== 'insert') continue;
        if (entry.updateOnly && op !== 'update') continue;
        const scope = effective(entry[op][role]);
        for (const at of SIDES) {
          if (at === 'a-other' && scope !== 'own') continue;
          const allowed = await guarded(entry, op, role, at);
          expect
            .soft(allowed, `${nameOf(entry)} ${op} as ${role} at ${at}`)
            .toBe(shouldAllow(scope, role, at));
        }
      }
    },
    240000,
  );
});
