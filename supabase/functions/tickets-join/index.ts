// supabase/functions/tickets-join/index.ts
import { createClient } from '@supabase/supabase-js';
import { createTicketAtomic } from '../_shared/create-ticket.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const authHeader = req.headers.get('Authorization');
  if (!authHeader) return new Response('Missing Authorization', { status: 401 });

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // As-the-caller client: resolves who is REALLY calling from their own verified JWT -- the body
  // is only ever trusted for WHAT they're requesting (branch/service/barber), never WHO they are.
  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData.user) return new Response('Unauthorized', { status: 401 });

  const admin = createClient(url, serviceRoleKey);
  const { data: customer, error: customerError } = await admin
    .from('customers')
    .select('id')
    .eq('auth_user_id', userData.user.id)
    .single();
  if (customerError || !customer) return new Response('No customer record', { status: 403 });

  const body = await req.json();
  const { branch_id, branch_service_id, preferred_barber_id } = body;
  if (!branch_id || !branch_service_id) {
    return new Response('branch_id and branch_service_id are required', { status: 400 });
  }

  try {
    const { ticket, wasExisting } = await createTicketAtomic({
      admin,
      branchId: branch_id,
      customerId: customer.id,
      branchServiceId: branch_service_id,
      preferredBarberId: preferred_barber_id ?? null,
      createdBy: 'customer',
      createdByStaffId: null,
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
