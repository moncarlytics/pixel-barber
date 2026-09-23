// supabase/functions/_shared/create-ticket.ts
// Shared by tickets-join and tickets-walk-in so both produce the identical ticket shape PRD
// section 12.1 requires ("all three [entry methods] produce the same kind of ticket") -- the only
// difference between them is how customer_id and created_by/created_by_staff_id get resolved,
// which each function's own index.ts handles before calling this.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface CreateTicketParams {
  admin: SupabaseClient;
  branchId: string;
  customerId: string;
  branchServiceId: string;
  preferredBarberId: string | null;
  acceptFallback: boolean;
  createdBy: 'customer' | 'staff';
  createdByStaffId: string | null;
}

export async function createTicketAtomic(params: CreateTicketParams) {
  const {
    admin,
    branchId,
    customerId,
    branchServiceId,
    preferredBarberId,
    acceptFallback,
    createdBy,
    createdByStaffId,
  } = params;

  // Idempotency (PRD 34): one_active_ticket_per_customer_branch is the real guard. Check for an
  // existing active ticket FIRST so a duplicate call (double-tap, or a walk-in re-registered by
  // accident) returns the existing ticket rather than racing the unique index and surfacing a raw
  // 23505 to the caller.
  const { data: existing } = await admin
    .from('queue_tickets')
    .select('*')
    .eq('customer_id', customerId)
    .eq('branch_id', branchId)
    .not('state', 'in', '(completed,cancelled,no_show)')
    .maybeSingle();
  if (existing) {
    return { ticket: existing, wasExisting: true };
  }

  // Resolve who this ticket is actually going to, re-deriving fresh rather than trusting any
  // earlier client-side pre-check (spec decision: assignment happens at join time). This runs
  // BEFORE next_ticket_number so a NO_BARBER_AVAILABLE refusal never burns a visible,
  // customer-facing ticket number.
  const { data: eligibility, error: eligibilityError } = await admin.rpc('find_eligible_barber', {
    p_branch_id: branchId,
    p_branch_service_id: branchServiceId,
    p_preferred_barber_id: preferredBarberId,
  });
  if (eligibilityError) throw eligibilityError;
  const result = eligibility?.[0];

  let assignedBarberId: string | null = null;
  if (preferredBarberId && result?.preferred_eligible) {
    assignedBarberId = preferredBarberId;
  } else if (preferredBarberId && result?.preferred_scheduled_today && !acceptFallback) {
    // Customer chose to wait specifically for their preferred barber.
    assignedBarberId = preferredBarberId;
  } else {
    assignedBarberId = result?.fallback_barber_id ?? null;
  }

  if (!assignedBarberId) {
    throw new Error('NO_BARBER_AVAILABLE');
  }

  const { data: ticketNumber, error: numberError } = await admin.rpc('next_ticket_number', {
    p_branch_id: branchId,
  });
  if (numberError) throw numberError;

  const { data: ticket, error: insertError } = await admin
    .from('queue_tickets')
    .insert({
      ticket_number: ticketNumber,
      branch_id: branchId,
      customer_id: customerId,
      branch_service_id: branchServiceId,
      preferred_barber_id: preferredBarberId,
      assigned_barber_id: assignedBarberId,
      state: 'waiting',
      created_by: createdBy,
      created_by_staff_id: createdByStaffId,
    })
    .select()
    .single();
  if (insertError) {
    // A genuine race (two concurrent requests both passing the pre-check above) hits the unique
    // index here instead -- re-select and return the winner's ticket rather than erroring, which
    // is what PRD 34's "the second attempt is a no-op that returns the existing ticket" requires.
    if (insertError.code === '23505') {
      const { data: winner } = await admin
        .from('queue_tickets')
        .select('*')
        .eq('customer_id', customerId)
        .eq('branch_id', branchId)
        .not('state', 'in', '(completed,cancelled,no_show)')
        .single();
      if (winner) return { ticket: winner, wasExisting: true };
    }
    throw insertError;
  }

  // Make the freshly-assigned barber's queue re-derive position/state immediately -- otherwise
  // an idle barber's very first ticket sits stuck at 'waiting' forever, since the only trigger
  // that calls recalculate_positions fires on a later state/skipped_at change, which may never
  // happen for a barber with an empty queue.
  await admin.rpc('recalculate_positions', {
    p_branch_id: branchId,
    p_barber_id: assignedBarberId,
  });

  await admin.from('queue_events').insert({
    ticket_id: ticket.id,
    event_type: 'joined',
    actor_type: createdBy === 'staff' ? 'staff' : 'customer',
    actor_id: createdBy === 'staff' ? createdByStaffId : customerId,
    after_state: { state: 'waiting' },
  });

  // Stub notification (Global Constraints): a real row so Phase 7 has something to pick up, but
  // nothing actually sends until that phase wires the real webhook-triggered sender.
  await admin.from('notifications').insert({
    recipient_type: 'customer',
    recipient_id: customerId,
    channel: 'sms',
    notification_type: 'ticket_created',
    related_ticket_id: ticket.id,
    payload: { ticket_number: ticket.ticket_number },
  });

  return { ticket, wasExisting: false };
}
