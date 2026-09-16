// supabase/functions/tickets-walk-in/index.ts
import { createClient } from '@supabase/supabase-js';
import { createTicketAtomic } from '../_shared/create-ticket.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response('Missing Authorization', { status: 401 });

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData.user) return new Response('Unauthorized', { status: 401 });

  const body = await req.json();
  const { branch_id, branch_service_id, preferred_barber_id, name, phone_e164 } = body;
  if (!branch_id || !branch_service_id || !name) {
    return new Response('branch_id, branch_service_id, and name are required', { status: 400 });
  }

  // Reuse the exact same authorization logic RLS trusts (has_capability/in_branch_scope), called
  // via RPC as the caller so it reads the caller's own JWT claims -- never re-derived in Deno.
  const { data: canEdit } = await asCaller.rpc('has_capability', { cap: 'edit_tickets' });
  const { data: inScope } = await asCaller.rpc('in_branch_scope', { target_branch: branch_id });
  if (!canEdit || !inScope) return new Response('Forbidden', { status: 403 });

  const { data: staffRow } = await asCaller
    .from('staff_users')
    .select('id')
    .eq('auth_user_id', userData.user.id)
    .single();
  if (!staffRow) return new Response('No staff record', { status: 403 });

  const admin = createClient(url, serviceRoleKey);

  // Match-or-create by phone (PRD section 13) -- a walk-in customer may already have an account
  // from a prior visit; a phone number is optional, in which case a fresh customer row is always
  // created (no way to match without one).
  let customerId: string;
  if (phone_e164) {
    const { data: existingCustomer } = await admin
      .from('customers')
      .select('id')
      .eq('phone_e164', phone_e164)
      .maybeSingle();
    if (existingCustomer) {
      customerId = existingCustomer.id;
    } else {
      const { data: newCustomer, error: createError } = await admin
        .from('customers')
        .insert({ name, phone_e164 })
        .select('id')
        .single();
      if (createError) throw createError;
      customerId = newCustomer.id;
    }
  } else {
    const { data: newCustomer, error: createError } = await admin
      .from('customers')
      .insert({ name, phone_e164: null })
      .select('id')
      .single();
    if (createError) throw createError;
    customerId = newCustomer.id;
  }

  try {
    const { ticket, wasExisting } = await createTicketAtomic({
      admin,
      branchId: branch_id,
      customerId,
      branchServiceId: branch_service_id,
      preferredBarberId: preferred_barber_id ?? null,
      createdBy: 'staff',
      createdByStaffId: staffRow.id,
    });
    return new Response(JSON.stringify({ ticket, wasExisting }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
});
