// tests/db/customer-staff-update-grants.test.ts
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

describe('customers/staff_users update-grant boundary', () => {
  it('authenticated can update exactly the customers self-service columns, nothing more', async () => {
    const columns = await getUpdatableColumns('customers', 'authenticated');
    expect(columns).toEqual(
      [
        'avatar_key',
        'email',
        'name',
        'preferred_branch_id',
        'push_enabled',
        'push_lead_minutes_primary',
        'push_lead_minutes_secondary',
        'sms_backup_enabled',
      ].sort(),
    );
  });

  it('authenticated can update exactly the staff_users self-service columns, nothing more', async () => {
    const columns = await getUpdatableColumns('staff_users', 'authenticated');
    expect(columns).toEqual(['email', 'name', 'phone_e164'].sort());
  });

  it('anon cannot update any column on customers or staff_users', async () => {
    const customerColumns = await getUpdatableColumns('customers', 'anon');
    const staffColumns = await getUpdatableColumns('staff_users', 'anon');
    expect(customerColumns).toEqual([]);
    expect(staffColumns).toEqual([]);
  });
});
