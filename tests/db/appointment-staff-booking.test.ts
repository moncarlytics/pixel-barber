// tests/db/appointment-staff-booking.test.ts
// @vitest-environment node
// staff_list_appointment_slots / staff_book_appointment: staff limits (no 1-hour minimum), find-or-
// create customer by phone, branch scope, and that staff can no longer write appointments directly.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  cleanupStaffLogin,
  createAppointmentFixture,
  createStaffLogin,
  dateAt,
  slotAt,
  deleteBranchAppointments,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;
let reception: Awaited<ReturnType<typeof createStaffLogin>>;
let otherManager: Awaited<ReturnType<typeof createStaffLogin>>;
const createdCustomerIds: string[] = [];

/** The next 30-minute grid slot that is still in the future (0–30 minutes away). */
function nextGridSlot(): string {
  return new Date(Math.ceil((Date.now() + 60_000) / 1_800_000) * 1_800_000).toISOString();
}

beforeAll(async () => {
  f = await createAppointmentFixture();
  reception = await createStaffLogin(f, 'rec', 'receptionist', f.branchId);
  otherManager = await createStaffLogin(f, 'mgr', 'branch_manager', f.closedBranchId);
}, 90000);

afterAll(async () => {
  await deleteBranchAppointments(f.admin, [f.branchId, f.closedBranchId]);
  await cleanupStaffLogin(f, reception);
  await cleanupStaffLogin(f, otherManager);
  if (createdCustomerIds.length > 0) {
    await f.admin.from('customers').delete().in('id', createdCustomerIds);
  }
  await cleanupAppointmentFixture(f);
}, 90000);

describe('staff_list_appointment_slots', () => {
  it('offers slots inside the hour that customers cannot book', async (ctx) => {
    const soon = nextGridSlot();
    const day = soon.slice(0, 10);
    // Barber B has no break, so the only reason a customer can't take this slot is the 1-hour rule.
    if (new Date(Date.parse(soon) + 1_800_000 - 1).toISOString().slice(0, 10) !== dateAt(0))
      ctx.skip(); // slot crosses UTC midnight
    const { data: staffSlots, error } = await reception.client.rpc('staff_list_appointment_slots', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberB.barberId,
      p_date: day,
    });
    expect(error).toBeNull();
    expect((staffSlots ?? []).map((s) => new Date(s).toISOString())).toContain(soon);
    const { data: customerSlots } = await f.customers[0].client.rpc('list_appointment_slots', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberB.barberId,
      p_date: day,
    });
    expect((customerSlots ?? []).map((s) => new Date(s).toISOString())).not.toContain(soon);
  });

  it('refuses a manager of another branch', async () => {
    const { error } = await otherManager.client.rpc('staff_list_appointment_slots', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
      p_date: dateAt(2),
    });
    expect(error?.message).toBe('not_allowed');
  });
});

describe('staff_book_appointment', () => {
  it('books for an existing customer found by phone, recorded as staff-created', async () => {
    const { data: id, error } = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberA.barberId,
      p_slot_start: slotAt(2, '10:00'),
      p_customer_name: 'Ignored For Existing',
      p_customer_phone: f.customers[0].phone,
    });
    expect(error).toBeNull();
    const { data: row } = await f.admin.from('appointments').select('*').eq('id', id!).single();
    expect(row).toMatchObject({
      customer_id: f.customers[0].customerId,
      created_by: 'staff',
      created_by_staff_id: reception.staffUserId,
      status: 'scheduled',
    });
  });

  it('creates a new customer for an unknown phone, and one with no phone', async () => {
    const phone = `+233559${f.suffix.slice(-6)}`;
    const { data: id, error } = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
      p_slot_start: slotAt(2, '11:00'),
      p_customer_name: 'Phone-in Customer',
      p_customer_phone: phone,
    });
    expect(error).toBeNull();
    const { data: row } = await f.admin
      .from('appointments')
      .select('customer_id, customers(name, phone_e164)')
      .eq('id', id!)
      .single();
    createdCustomerIds.push(row!.customer_id);
    expect(row!.customers).toMatchObject({ name: 'Phone-in Customer', phone_e164: phone });

    const { data: id2, error: e2 } = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
      p_slot_start: slotAt(2, '11:30'),
      p_customer_name: 'No Phone Customer',
      p_customer_phone: null,
    });
    expect(e2).toBeNull();
    const { data: row2 } = await f.admin
      .from('appointments')
      .select('customer_id, customers(phone_e164)')
      .eq('id', id2!)
      .single();
    createdCustomerIds.push(row2!.customer_id);
    expect(row2!.customers).toMatchObject({ phone_e164: null });
  });

  it('still refuses double-booking, a second same-day booking and a bad phone', async () => {
    const taken = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberA.barberId,
      p_slot_start: slotAt(2, '10:00'),
      p_customer_name: 'Someone',
      p_customer_phone: f.customers[1].phone,
    });
    expect(taken.error?.message).toBe('slot_taken');
    const sameDay = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberB.barberId,
      p_slot_start: slotAt(2, '15:00'),
      p_customer_name: 'x',
      p_customer_phone: f.customers[0].phone,
    });
    expect(sameDay.error?.message).toBe('already_booked_that_day');
    const badPhone = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
      p_slot_start: slotAt(3, '10:00'),
      p_customer_name: 'x',
      p_customer_phone: '0244',
    });
    expect(badPhone.error?.message).toBe('invalid_phone');
  });

  it('refuses a slot that has already started, and callers without authority', async () => {
    const past = new Date(Math.floor(Date.now() / 1_800_000) * 1_800_000).toISOString();
    const started = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: null,
      p_slot_start: past,
      p_customer_name: 'x',
      p_customer_phone: f.customers[2].phone,
    });
    expect(started.error?.message).toBe('too_soon');
    for (const client of [otherManager.client, f.barberClient, f.customers[3].client]) {
      const { error } = await client.rpc('staff_book_appointment', {
        p_branch_service_id: f.branchServiceId,
        p_barber_id: null,
        p_slot_start: slotAt(4, '10:00'),
        p_customer_name: 'x',
        p_customer_phone: f.customers[3].phone,
      });
      expect(error?.message).toBe('not_allowed');
    }
  });

  it('lets staff book a slot less than an hour away that a customer cannot', async (ctx) => {
    const soon = nextGridSlot();
    if (new Date(Date.parse(soon) + 1_800_000 - 1).toISOString().slice(0, 10) !== dateAt(0))
      ctx.skip(); // slot crosses UTC midnight
    const viaCustomer = await f.customers[3].client.rpc('book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberB.barberId,
      p_slot_start: soon,
    });
    expect(viaCustomer.error?.message).toBe('too_soon');
    const viaStaff = await reception.client.rpc('staff_book_appointment', {
      p_branch_service_id: f.branchServiceId,
      p_barber_id: f.barberB.barberId,
      p_slot_start: soon,
      p_customer_name: 'x',
      p_customer_phone: f.customers[3].phone,
    });
    expect(viaStaff.error).toBeNull();
  });
});

describe('direct writes', () => {
  it('staff can read but no longer insert or update appointments directly', async () => {
    const { data: visible } = await reception.client
      .from('appointments')
      .select('id')
      .eq('branch_id', f.branchId);
    expect((visible ?? []).length).toBeGreaterThan(0);
    const { error: insertError } = await reception.client.from('appointments').insert({
      customer_id: f.customers[2].customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      scheduled_start: slotAt(5, '10:00'),
      scheduled_end: slotAt(5, '10:30'),
      created_by: 'staff',
    });
    expect(insertError).not.toBeNull();
    const { data: updated } = await reception.client
      .from('appointments')
      .update({ status: 'cancelled' })
      .eq('id', visible![0].id)
      .select();
    expect(updated ?? []).toHaveLength(0);
  });
});
