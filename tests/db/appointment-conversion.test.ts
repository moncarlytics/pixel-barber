// tests/db/appointment-conversion.test.ts
// @vitest-environment node
// activate_due_appointments: a due appointment becomes a ticket served next (behind the called
// ticket, ahead of waiting walk-ins), a branch-closed one is cancelled, an existing active ticket
// takes the appointment instead of a second ticket, an offline preferred barber is replaced, and the
// appointment status follows its ticket (no_show / completed / cancelled). The live cron job may
// run the function concurrently -- the outcome is identical, so the tests read final state.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  cleanupAppointmentFixture,
  createAppointmentFixture,
  type AppointmentFixture,
} from './fixtures/appointments';

let f: AppointmentFixture;

async function walkIn(customerIdx: number, barberId: string) {
  const { data: number } = await f.admin.rpc('next_ticket_number', { p_branch_id: f.branchId });
  const { data, error } = await f.admin
    .from('queue_tickets')
    .insert({
      ticket_number: number!,
      branch_id: f.branchId,
      customer_id: f.customers[customerIdx].customerId,
      branch_service_id: f.branchServiceId,
      assigned_barber_id: barberId,
      state: 'waiting',
      created_by: 'staff',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function dueAppointment(
  customerIdx: number,
  barberId: string | null,
  where: { branchId: string; branchServiceId: string } = {
    branchId: f.branchId,
    branchServiceId: f.branchServiceId,
  },
) {
  const start = new Date(Date.now() - 60 * 1000);
  const { data, error } = await f.admin
    .from('appointments')
    .insert({
      customer_id: f.customers[customerIdx].customerId,
      branch_id: where.branchId,
      branch_service_id: where.branchServiceId,
      preferred_barber_id: barberId,
      scheduled_start: start.toISOString(),
      scheduled_end: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
      status: 'scheduled',
      created_by: 'customer',
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

async function activate() {
  const { error } = await f.admin.rpc('activate_due_appointments');
  if (error) throw error;
}

async function ticketsFor(appointmentId: string) {
  const { data } = await f.admin
    .from('queue_tickets')
    .select('*')
    .eq('appointment_id', appointmentId);
  return data ?? [];
}

beforeAll(async () => {
  f = await createAppointmentFixture();
}, 90000);

afterAll(async () => {
  await cleanupAppointmentFixture(f);
}, 90000);

describe('activate_due_appointments', () => {
  let apptId: string;
  let calledId: string;
  let waitingId: string;

  it('converts a due appointment into the next ticket, behind the called one', async () => {
    calledId = await walkIn(0, f.barberA.barberId);
    waitingId = await walkIn(1, f.barberA.barberId);
    await f.admin.rpc('recalculate_positions', {
      p_branch_id: f.branchId,
      p_barber_id: f.barberA.barberId,
    });

    apptId = await dueAppointment(2, f.barberA.barberId);
    await activate();

    const [ticket] = await ticketsFor(apptId);
    expect(ticket).toMatchObject({
      assigned_barber_id: f.barberA.barberId,
      created_by: 'appointment_conversion',
      position: 2,
      state: 'almost_turn',
    });
    const { data: others } = await f.admin
      .from('queue_tickets')
      .select('id, position, state')
      .in('id', [calledId, waitingId]);
    const byId = new Map((others ?? []).map((t) => [t.id, t]));
    expect(byId.get(calledId)).toMatchObject({ position: 1, state: 'called' });
    expect(byId.get(waitingId)).toMatchObject({ position: 3, state: 'waiting' });

    const { data: appt } = await f.admin
      .from('appointments')
      .select('status')
      .eq('id', apptId)
      .single();
    expect(appt!.status).toBe('converted');
    const { data: events } = await f.admin
      .from('queue_events')
      .select('event_type, actor_type')
      .eq('ticket_id', ticket.id);
    expect(events).toContainEqual({ event_type: 'created', actor_type: 'system' });
  });

  it('a skipped appointment ticket loses its priority', async () => {
    const [ticket] = await ticketsFor(apptId);
    await f.admin
      .from('queue_tickets')
      .update({ skipped_at: new Date().toISOString() })
      .eq('id', ticket.id);
    const { data } = await f.admin
      .from('queue_tickets')
      .select('id, position')
      .in('id', [ticket.id, waitingId]);
    const byId = new Map((data ?? []).map((t) => [t.id, t.position]));
    expect(byId.get(waitingId)!).toBeLessThan(byId.get(ticket.id)!);
  });

  it('marks the appointment no_show when its ticket becomes no_show', async () => {
    const [ticket] = await ticketsFor(apptId);
    await f.admin.from('queue_tickets').update({ state: 'no_show' }).eq('id', ticket.id);
    const { data } = await f.admin.from('appointments').select('status').eq('id', apptId).single();
    expect(data!.status).toBe('no_show');
  });

  it('marks the appointment completed when its ticket completes', async () => {
    const id = await dueAppointment(3, f.barberB.barberId);
    await activate();
    const [ticket] = await ticketsFor(id);
    expect(ticket.assigned_barber_id).toBe(f.barberB.barberId);
    await f.admin.from('queue_tickets').update({ state: 'completed' }).eq('id', ticket.id);
    const { data } = await f.admin.from('appointments').select('status').eq('id', id).single();
    expect(data!.status).toBe('completed');
  });

  it('gives an existing active ticket the appointment instead of creating a second one', async () => {
    // Customer 1 still has the waiting walk-in from the first case.
    const id = await dueAppointment(1, f.barberA.barberId);
    await activate();
    const tickets = await ticketsFor(id);
    expect(tickets).toHaveLength(1);
    expect(tickets[0].id).toBe(waitingId);
    const { data } = await f.admin.from('appointments').select('status').eq('id', id).single();
    expect(data!.status).toBe('converted');
  });

  it('reassigns when the preferred barber is offline', async () => {
    await f.admin.from('queue_tickets').update({ state: 'completed' }).eq('id', calledId);
    await f.admin.from('barbers').update({ status: 'offline' }).eq('id', f.barberB.barberId);
    const id = await dueAppointment(0, f.barberB.barberId);
    await activate();
    const [ticket] = await ticketsFor(id);
    expect(ticket.assigned_barber_id).toBe(f.barberA.barberId);
    await f.admin.from('barbers').update({ status: 'available' }).eq('id', f.barberB.barberId);
  });

  it('reassigns when the preferred barber has ended their shift', async () => {
    // Customer 0's ticket from the previous case is still active; finish it so they are free.
    const { data: active } = await f.admin
      .from('queue_tickets')
      .select('id')
      .eq('customer_id', f.customers[0].customerId)
      .eq('branch_id', f.branchId)
      .not('state', 'in', '(completed,cancelled,no_show)');
    for (const t of active ?? []) {
      await f.admin.from('queue_tickets').update({ state: 'completed' }).eq('id', t.id);
    }
    await f.admin.from('barbers').update({ status: 'end_of_shift' }).eq('id', f.barberB.barberId);
    const id = await dueAppointment(0, f.barberB.barberId);
    await activate();
    const [ticket] = await ticketsFor(id);
    expect(ticket.assigned_barber_id).toBe(f.barberA.barberId);
    await f.admin.from('barbers').update({ status: 'available' }).eq('id', f.barberB.barberId);
  });

  it('cancels an appointment whose branch is closed today', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await f.admin
      .from('branch_closures')
      .insert({ branch_id: f.closedBranchId, closure_date: today });
    const id = await dueAppointment(2, null, {
      branchId: f.closedBranchId,
      branchServiceId: f.closedBranchServiceId,
    });
    await activate();
    expect(await ticketsFor(id)).toHaveLength(0);
    const { data } = await f.admin.from('appointments').select('*').eq('id', id).single();
    expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'branch_closed' });
  });

  it('cancels the appointment when the customer cancels its ticket', async () => {
    const id = await dueAppointment(3, null);
    await activate();
    const [ticket] = await ticketsFor(id);
    await f.admin
      .from('queue_tickets')
      .update({ state: 'cancelled', cancel_reason: 'emergency' })
      .eq('id', ticket.id);
    const { data } = await f.admin.from('appointments').select('*').eq('id', id).single();
    expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'emergency' });
  });

  it('leaves the appointment scheduled, with no ticket, when no barber is eligible', async () => {
    // Customer 3's earlier tickets are all finished, so they are free.
    await f.admin
      .from('barbers')
      .update({ status: 'offline' })
      .in('id', [f.barberA.barberId, f.barberB.barberId]);
    const id = await dueAppointment(3, f.barberA.barberId);
    try {
      await activate();
      expect(await ticketsFor(id)).toHaveLength(0);
      const { data } = await f.admin.from('appointments').select('status').eq('id', id).single();
      expect(data!.status).toBe('scheduled');
    } finally {
      await f.admin
        .from('barbers')
        .update({ status: 'available' })
        .in('id', [f.barberA.barberId, f.barberB.barberId]);
      await f.admin.from('appointments').delete().eq('id', id);
    }
  });

  it('cancels a scheduled appointment whose slot has already ended', async () => {
    const start = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const { data: row, error } = await f.admin
      .from('appointments')
      .insert({
        customer_id: f.customers[3].customerId,
        branch_id: f.branchId,
        branch_service_id: f.branchServiceId,
        preferred_barber_id: f.barberA.barberId,
        scheduled_start: start.toISOString(),
        scheduled_end: new Date(start.getTime() + 30 * 60 * 1000).toISOString(),
        status: 'scheduled',
        created_by: 'customer',
      })
      .select('id')
      .single();
    if (error) throw error;
    await activate();
    expect(await ticketsFor(row.id)).toHaveLength(0);
    const { data } = await f.admin.from('appointments').select('*').eq('id', row.id).single();
    expect(data).toMatchObject({ status: 'cancelled', cancel_reason: 'other' });
    expect(data!.cancelled_at).not.toBeNull();
  });

  it('keeps the appointment scheduled when the existing ticket already carries another one', async () => {
    // Customer 1's waiting walk-in already carries an appointment (attached in an earlier case).
    const countEvents = async () => {
      const { data } = await f.admin
        .from('queue_events')
        .select('id')
        .eq('ticket_id', waitingId)
        .eq('event_type', 'appointment_attached');
      return (data ?? []).length;
    };
    const before = await countEvents();
    const id = await dueAppointment(1, f.barberA.barberId);
    try {
      await activate();
      const { data } = await f.admin.from('appointments').select('status').eq('id', id).single();
      expect(data!.status).toBe('scheduled');
      expect(await ticketsFor(id)).toHaveLength(0);
      expect(await countEvents()).toBe(before);
    } finally {
      await f.admin.from('appointments').delete().eq('id', id);
    }
  });
});
