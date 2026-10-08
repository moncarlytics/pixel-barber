// tests/db/rbac/reads.test.ts
// @vitest-environment node
// Every role reads every public table/view; the rows that come back must match the matrix.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TABLES } from './tables';
import { ROLES, effective, type ReadScope, type Role, type RowSet } from './types';
import { cleanupRbacFixture, createRbacFixture, type RbacFixture } from './fixture';

let f: RbacFixture;
beforeAll(async () => {
  f = await createRbacFixture();
}, 180000);
afterAll(async () => {
  await cleanupRbacFixture(f);
}, 180000);

function expectedRows(scope: ReadScope, role: Role, rows: RowSet): string[] {
  const branchRows = role === 'otherManager' ? rows.b : rows.a;
  const set =
    scope === 'none'
      ? []
      : scope === 'own'
        ? rows.own
        : scope === 'branch'
          ? branchRows
          : [...rows.a, ...rows.b];
  return [...new Set(set)].sort();
}

describe.each(TABLES)('$table $rowsKey', (entry) => {
  it.each(ROLES)('%s', async (role) => {
    const rowsKey = entry.rowsKey ?? entry.table;
    const rows = f.rows[rowsKey];
    if (!rows) throw new Error(`fixture has no rows for ${rowsKey}`);
    const ids = [...new Set([...rows.a, ...rows.b, ...rows.own])];
    const { data, error } = await f.clients[role]
      .from(entry.table as never)
      .select(entry.key)
      .in(entry.key, ids);
    // A permission error (42501) means "no rows"; any other error is a real failure.
    if (error && error.code !== '42501') {
      throw new Error(`${entry.table} as ${role}: ${error.message}`);
    }
    const seen = error
      ? []
      : [
          ...new Set((data ?? []).map((r) => String((r as Record<string, unknown>)[entry.key]))),
        ].sort();
    const scope = effective(entry.read[role]);
    expect(seen, `${entry.table} as ${role}${error ? ` (error: ${error.message})` : ''}`).toEqual(
      expectedRows(scope, role, rows),
    );
  });
});
