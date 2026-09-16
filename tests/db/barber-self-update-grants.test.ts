// tests/db/barber-self-update-grants.test.ts
// @vitest-environment node
import { config } from 'dotenv';
config({ path: '.env.local' });
import { describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

async function getUpdatableColumns(table: string, grantee: string): Promise<string[]> {
  const { data, error } = await admin.rpc('get_update_grants', {
    p_table: table,
    p_grantee: grantee,
  });
  if (error) throw error;
  return (data as { column_name: string }[]).map((r) => r.column_name).sort();
}

describe('barbers update-grant boundary', () => {
  it('authenticated can update exactly the barbers self-service columns, nothing more', async () => {
    const columns = await getUpdatableColumns('barbers', 'authenticated');
    expect(columns).toEqual(['home_branch_id', 'status'].sort());
  });

  it('anon cannot update any column on barbers', async () => {
    const columns = await getUpdatableColumns('barbers', 'anon');
    expect(columns).toEqual([]);
  });
});
