// tests/db/list-bookable-barbers-names.test.ts
// @vitest-environment node
// list_bookable_barbers returns each bookable barber's display name (so pickers can show names, not
// ids) and nothing else about the staff account -- callable by signed-out visitors too.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('list_bookable_barbers', () => {
  it('returns display names and only the public barber fields, even when signed out', async () => {
    const anon = createClient<Database>(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } },
    );
    const { data, error } = await anon.rpc('list_bookable_barbers', { p_branch_id: f.branchId });
    expect(error).toBeNull();
    const byId = new Map((data ?? []).map((b) => [b.id, b]));
    expect(byId.get(f.barberA.barberId)?.display_name).toBe('Appt Barber a');
    expect(byId.get(f.barberB.barberId)?.display_name).toBe('Appt Barber b');
    for (const row of data ?? []) {
      expect(Object.keys(row).sort()).toEqual(
        ['display_name', 'home_branch_id', 'id', 'staff_user_id', 'status'].sort(),
      );
    }
  });

  it('still leaves out barbers whose account is inactive', async () => {
    await f.admin.from('staff_users').update({ is_active: false }).eq('id', f.barberB.staffUserId);
    const { data } = await f.admin.rpc('list_bookable_barbers', { p_branch_id: f.branchId });
    expect((data ?? []).map((b) => b.id)).not.toContain(f.barberB.barberId);
    await f.admin.from('staff_users').update({ is_active: true }).eq('id', f.barberB.staffUserId);
  });
});
