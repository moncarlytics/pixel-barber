// tests/db/customer-staff-read.test.ts
// @vitest-environment node
// Staff never read the customers table directly (the customer list masks phones for some roles,
// so a direct read would bypass it): every staff role gets no rows, a customer still reads their
// own record, and the customer list still works through its function.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
let manager: Awaited<ReturnType<typeof createStaffLogin>>;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let analyst: Awaited<ReturnType<typeof createStaffLogin>>;

beforeAll(async () => {
  f = await createAppointmentFixture();
  manager = await createStaffLogin(f, 'srm', 'branch_manager', f.branchId);
  reception = await createStaffLogin(f, 'srr', 'receptionist', f.branchId);
  analyst = await createStaffLogin(f, 'sra', 'analyst', f.branchId);
  const { error } = await f.admin.from('queue_tickets').insert({
    ticket_number: `PB-SR-${f.suffix}`,
    branch_id: f.branchId,
    customer_id: f.customers[0]!.customerId,
    branch_service_id: f.branchServiceId,
    state: 'completed',
    completed_at: new Date().toISOString(),
    created_by: 'customer',
  });
  if (error) throw error;
}, 90000);

afterAll(async () => {
  for (const login of [manager, reception, analyst]) await cleanupStaffLogin(f, login);
  await cleanupAppointmentFixture(f);
}, 90000);

describe('customers table, read directly', () => {
  it('returns nothing to any staff role, even for a customer of their branch', async () => {
    for (const client of [manager.client, reception.client, analyst.client, f.barberClient]) {
      const { data, error } = await client
        .from('customers')
        .select('id, phone_e164, email')
        .eq('id', f.customers[0]!.customerId);
      expect(error).toBeNull();
      expect(data).toEqual([]);
    }
  });

  it('still lets a customer read their own record', async () => {
    const { data, error } = await f.customers[0]!.client.from('customers')
      .select('id, phone_e164')
      .eq('id', f.customers[0]!.customerId);
    expect(error).toBeNull();
    expect(data).toEqual([{ id: f.customers[0]!.customerId, phone_e164: f.customers[0]!.phone }]);
  });

  it('still lists the customer for staff through the customer list', async () => {
    const { data, error } = await manager.client.rpc('list_customers', {
      p_branch_ids: [f.branchId],
      p_search: null,
      p_group: null,
      p_offset: 0,
    });
    expect(error).toBeNull();
    const rows = (data as { rows: { id: string }[] }).rows;
    expect(rows.map((r) => r.id)).toContain(f.customers[0]!.customerId);
  });
});
