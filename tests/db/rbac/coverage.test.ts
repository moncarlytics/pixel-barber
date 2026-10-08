// tests/db/rbac/coverage.test.ts
// @vitest-environment node
// Every public table and view is in the matrix, and the matrix names nothing that no longer exists.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { describe, expect, it } from 'vitest';
import { TABLES } from './tables';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

describe('coverage', () => {
  it('classifies every public table and view', async () => {
    const res = await fetch(`${url}/rest/v1/`, {
      headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
    });
    const spec = (await res.json()) as { definitions?: Record<string, unknown> };
    const exposed = Object.keys(spec.definitions ?? {}).sort();
    const classified = [...new Set(TABLES.map((t) => t.table))].sort();
    expect(
      exposed.filter((t) => !classified.includes(t)),
      'tables/views missing from the matrix',
    ).toEqual([]);
    expect(
      classified.filter((t) => !exposed.includes(t)),
      'matrix entries that no longer exist',
    ).toEqual([]);
  });
});
