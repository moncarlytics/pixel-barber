// tests/db/rbac/coverage.test.ts
// @vitest-environment node
// Every public table and view is in the matrix, and the matrix names nothing that no longer exists.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { createClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { FUNCTIONS } from './functions';
import { TABLES, WRITES } from './tables';
import { OPEN_GAPS } from './types';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

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

  it('has a write entry for every base table (and only those)', () => {
    const views = ['branch_status_view', 'current_branch_service_price', 'customer_segments'];
    const base = [...new Set(TABLES.map((t) => t.table))].filter((t) => !views.includes(t)).sort();
    // A table may have more than one write entry (e.g. the forged-ticket probe).
    const written = [...new Set(WRITES.map((w) => w.table))].sort();
    expect(written).toEqual(base);
  });

  it('classifies every callable function', async () => {
    const { data, error } = await admin.rpc('rbac_callable_functions' as never);
    expect(error).toBeNull();
    const callable = ((data ?? []) as { name: string }[]).map((r) => r.name).sort();
    const classified = FUNCTIONS.map((fn) => fn.name).sort();
    expect(
      callable.filter((n) => !classified.includes(n)),
      'functions missing from the matrix',
    ).toEqual([]);
    expect(
      classified.filter((n) => !callable.includes(n)),
      'matrix entries that no longer exist',
    ).toEqual([]);
  });

  it('pins the open gaps', () => {
    const gaps = new Set<string>();
    const collect = (x: { gap?: string }) => {
      if (x.gap) gaps.add(x.gap);
    };
    for (const t of TABLES) Object.values(t.read).forEach(collect);
    for (const w of WRITES) {
      for (const op of ['insert', 'update', 'delete'] as const)
        Object.values(w[op]).forEach(collect);
    }
    for (const fn of FUNCTIONS) Object.values(fn.outcome).forEach(collect);
    expect([...gaps].sort()).toEqual(OPEN_GAPS);
  });
});
