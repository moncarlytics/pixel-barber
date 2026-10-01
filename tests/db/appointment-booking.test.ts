// tests/db/appointment-booking.test.ts
// @vitest-environment node
// list_appointment_slots / book_appointment: every slot rule, "any barber" capacity, double-booking
// refusal, and that customers can only write appointments through the functions.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  dateAt,
  slotAt,
  type AppointmentFixture,
  type Client,
} from './fixtures/appointments';

let f: AppointmentFixture;

async function slots(client: Client, barberId: string | null, dayOffset: number) {
  const { data, error } = await client.rpc('list_appointment_slots', {
    p_branch_service_id: f.branchServiceId,
    p_barber_id: barberId,
    p_date: dateAt(dayOffset),
  });
  if (error) throw error;
  return (data ?? []).map((s) => new Date(s).toISOString());
}

async function book(client: Client, barberId: string | null, slot: string, bsId?: string) {
  return client.rpc('book_appointment', {
    p_branch_service_id: bsId ?? f.branchServiceId,
    p_barber_id: barberId,
    p_slot_start: slot,
  });
}

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('list_appointment_slots', () => {
  it('lists 30-minute slots inside the shift and skips the barber break', async () => {
    const forA = await slots(f.customers[0].client, f.barberA.barberId, 2);
    expect(forA).toContain(slotAt(2, '10:00'));
    expect(forA).toContain(slotAt(2, '10:30'));
    expect(forA).not.toContain(slotAt(2, '12:00'));
    expect(forA).not.toContain(slotAt(2, '12:30'));
    // B has no break, so "any barber" still offers 12:00.
    expect(await slots(f.customers[0].client, null, 2)).toContain(slotAt(2, '12:00'));
  });

  it('offers nothing beyond 14 days ahead', async () => {
    expect(await slots(f.customers[0].client, f.barberA.barberId, 15)).toEqual([]);
  });
});

describe('book_appointment', () => {
  it('refuses a slot less than an hour away and one more than 14 days ahead', async () => {
    const soon = new Date(Math.ceil(Date.now() / 1_800_000) * 1_800_000).toISOString();
    expect((await book(f.customers[0].client, f.barberA.barberId, soon)).error?.message).toBe(
      'too_soon',
    );
    expect(
      (await book(f.customers[0].client, f.barberA.barberId, slotAt(15, '10:00'))).error?.message,
    ).toBe('too_far_ahead');
  });

  it('books a free slot once and refuses the same barber slot to anyone else', async () => {
    const { data: id, error } = await book(
      f.customers[0].client,
      f.barberA.barberId,
      slotAt(2, '10:00'),
    );
    expect(error).toBeNull();
    const { data: row } = await f.admin.from('appointments').select('*').eq('id', id!).single();
    expect(row).toMatchObject({
      customer_id: f.customers[0].customerId,
      branch_id: f.branchId,
      preferred_barber_id: f.barberA.barberId,
      status: 'scheduled',
      created_by: 'customer',
    });
    expect(new Date(row!.scheduled_end).getTime() - new Date(row!.scheduled_start).getTime()).toBe(
      30 * 60 * 1000,
    );

    expect(
      (await book(f.customers[1].client, f.barberA.barberId, slotAt(2, '10:00'))).error?.message,
    ).toBe('slot_taken');
    expect(await slots(f.customers[1].client, f.barberA.barberId, 2)).not.toContain(
      slotAt(2, '10:00'),
    );
    // B is still free at 10:00.
    expect(await slots(f.customers[1].client, null, 2)).toContain(slotAt(2, '10:00'));
  });

  it('allows one appointment per customer per day', async () => {
    expect(
      (await book(f.customers[0].client, f.barberB.barberId, slotAt(2, '15:00'))).error?.message,
    ).toBe('already_booked_that_day');
  });

  it('caps "any barber" bookings at the number of free barbers', async () => {
    const at = slotAt(3, '14:00');
    expect((await book(f.customers[1].client, null, at)).error).toBeNull();
    expect((await book(f.customers[2].client, null, at)).error).toBeNull();
    expect((await book(f.customers[3].client, null, at)).error?.message).toBe('slot_taken');
    // A named booking may not squeeze out the two "any barber" bookings either.
    expect((await book(f.customers[0].client, f.barberA.barberId, at)).error?.message).toBe(
      'slot_taken',
    );
    expect(await slots(f.customers[3].client, null, 3)).not.toContain(at);
  });

  it('refuses a day the branch is closed', async () => {
    await f.admin
      .from('branch_closures')
      .insert({ branch_id: f.closedBranchId, closure_date: dateAt(4) });
    const { error } = await book(
      f.customers[3].client,
      null,
      slotAt(4, '10:00'),
      f.closedBranchServiceId,
    );
    expect(error?.message).toBe('branch_closed');
  });

  it('refuses callers who are not customers', async () => {
    expect(
      (await book(f.barberClient, f.barberA.barberId, slotAt(5, '10:00'))).error?.message,
    ).toBe('not_a_customer');
  });
});

describe('direct writes', () => {
  it('customers cannot insert or update appointments directly', async () => {
    const c = f.customers[3];
    const { error: insertError } = await c.client.from('appointments').insert({
      customer_id: c.customerId,
      branch_id: f.branchId,
      branch_service_id: f.branchServiceId,
      scheduled_start: slotAt(6, '10:00'),
      scheduled_end: slotAt(6, '10:30'),
      created_by: 'customer',
    });
    expect(insertError).not.toBeNull();

    const { data: mine } = await f.admin
      .from('appointments')
      .select('id')
      .eq('customer_id', f.customers[1].customerId)
      .limit(1)
      .single();
    const { data: updated } = await f.customers[1].client
      .from('appointments')
      .update({ scheduled_start: slotAt(6, '09:00') })
      .eq('id', mine!.id)
      .select();
    expect(updated ?? []).toHaveLength(0);
  });
});
