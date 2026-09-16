// tests/db/barber-current-ticket-trigger.test.ts
// @vitest-environment node
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = Date.now();

let branchId: string;
let branchServiceId: string;
let customerId: string;
let barberAId: string;
let barberBId: string;
let ticketId: string;
const createdStaffAuthIds: string[] = [];

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: `Barber Trigger Test Branch`,
      branch_code: `BCT${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  branchId = branch!.id;

  const { data: branchService } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: service!.id })
    .select()
    .single();
  branchServiceId = branchService!.id;

  const { data: customer } = await admin
    .from('customers')
    .insert({
      name: 'Barber Trigger Test Customer',
      phone_e164: `+233${String(suffix).slice(-9)}`,
    })
    .select()
    .single();
  customerId = customer!.id;

  async function createBarber(label: 'a' | 'b') {
    const email = `barber-trigger-test-${label}-${suffix}@test.pixelbarber.local`;
    const { data: staffUser } = await admin.auth.admin.createUser({
      email,
      password: 'Test-Password-123!',
      email_confirm: true,
    });
    createdStaffAuthIds.push(staffUser!.user.id);
    const { data: staffRow } = await admin
      .from('staff_users')
      .insert({
        auth_user_id: staffUser!.user.id,
        name: `Barber Trigger Test ${label.toUpperCase()}`,
        email,
        role: 'barber',
        invite_status: 'accepted',
      })
      .select()
      .single();
    const { data: barberRow } = await admin
      .from('barbers')
      .insert({ staff_user_id: staffRow!.id, home_branch_id: branchId })
      .select()
      .single();
    return barberRow!.id as string;
  }

  barberAId = await createBarber('a');
  barberBId = await createBarber('b');

  const { data: ticket } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: `PB-TRIGTEST-${suffix % 100000}`,
      branch_id: branchId,
      customer_id: customerId,
      branch_service_id: branchServiceId,
      assigned_barber_id: barberAId,
      state: 'waiting',
      created_by: 'staff',
    })
    .select()
    .single();
  ticketId = ticket!.id;
}, 30000);

afterAll(async () => {
  // Safety: clear current_ticket_id on both barbers first, since barbers.current_ticket_id
  // references queue_tickets(id) with no cascade -- if an assertion above failed mid-test and left
  // either barber pointing at the ticket, deleting the ticket first would violate that FK.
  await admin
    .from('barbers')
    .update({ current_ticket_id: null })
    .in('id', [barberAId, barberBId].filter(Boolean));
  if (ticketId) {
    await admin.from('queue_tickets').delete().eq('id', ticketId);
  }
  if (customerId) {
    await admin.from('customers').delete().eq('id', customerId);
  }
  // staff_users.id -> barbers.staff_user_id cascades, so deleting staff_users removes the
  // barbers rows too; staff_users.auth_user_id is `on delete restrict`, so the staff_users row
  // must go before its auth.users row.
  for (const authId of createdStaffAuthIds) {
    await admin.from('staff_users').delete().eq('auth_user_id', authId);
    await admin.auth.admin.deleteUser(authId);
  }
  if (branchId) {
    await admin.from('branches').delete().eq('id', branchId);
  }
}, 30000);

describe('barbers.current_ticket_id trigger maintenance', () => {
  it('sets the assigned barber current_ticket_id when a ticket enters in_service', async () => {
    const { error } = await admin
      .from('queue_tickets')
      .update({ state: 'in_service' })
      .eq('id', ticketId);
    expect(error).toBeNull();

    const { data: barberA } = await admin
      .from('barbers')
      .select('current_ticket_id')
      .eq('id', barberAId)
      .single();
    expect(barberA!.current_ticket_id).toBe(ticketId);
  });

  it('moves current_ticket_id to the new barber on reassignment without a state change', async () => {
    const { error } = await admin
      .from('queue_tickets')
      .update({ assigned_barber_id: barberBId })
      .eq('id', ticketId);
    expect(error).toBeNull();

    const { data: barberA } = await admin
      .from('barbers')
      .select('current_ticket_id')
      .eq('id', barberAId)
      .single();
    expect(barberA!.current_ticket_id).toBeNull();

    const { data: barberB } = await admin
      .from('barbers')
      .select('current_ticket_id')
      .eq('id', barberBId)
      .single();
    expect(barberB!.current_ticket_id).toBe(ticketId);
  });

  it('clears the assigned barber current_ticket_id when the ticket leaves in_service', async () => {
    const { error } = await admin
      .from('queue_tickets')
      .update({ state: 'completed' })
      .eq('id', ticketId);
    expect(error).toBeNull();

    const { data: barberB } = await admin
      .from('barbers')
      .select('current_ticket_id')
      .eq('id', barberBId)
      .single();
    expect(barberB!.current_ticket_id).toBeNull();
  });
});
