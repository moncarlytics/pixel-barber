// tests/db/queue-tickets-update-grants.test.ts
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

describe('queue_tickets update-grant boundary', () => {
  it('authenticated can update exactly the intended columns, nothing more', async () => {
    const columns = await getUpdatableColumns('queue_tickets', 'authenticated');
    expect(columns).toEqual(
      [
        'state',
        'cancel_reason',
        'cancelled_at',
        'called_at',
        'confirmed_at',
        'service_started_at',
        'completed_at',
        'grace_period_expires_at',
        'skipped_at',
      ].sort(),
    );
  });

  it('anon cannot update any column on queue_tickets', async () => {
    const columns = await getUpdatableColumns('queue_tickets', 'anon');
    expect(columns).toEqual([]);
  });

  it('version is not in the grant at all -- exclusively trigger-maintained', async () => {
    const columns = await getUpdatableColumns('queue_tickets', 'authenticated');
    expect(columns).not.toContain('version');
  });
});
