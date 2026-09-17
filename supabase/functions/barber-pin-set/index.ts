// supabase/functions/barber-pin-set/index.ts
// Ruling (this plan's preflight scan): PIN set/rotate is an operational barber-management action,
// not account creation, and is gated on manage_barber_schedules -- the exact capability already
// granted only to owner/branch_manager, matching backend-schema 3.3's "by a Branch Manager or
// Owner" precisely. Never accepts or returns a plaintext-comparable hash; the caller only ever
// learns success/failure.
import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  const authHeader = req.headers.get('Authorization');
  if (!authHeader)
    return new Response('Missing Authorization', { status: 401, headers: corsHeaders });

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: userData, error: userError } = await asCaller.auth.getUser();
  if (userError || !userData.user)
    return new Response('Unauthorized', { status: 401, headers: corsHeaders });

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const { barber_staff_user_id, pin } = body;
  if (!barber_staff_user_id || !pin || !/^\d{4,6}$/.test(pin)) {
    return new Response(
      JSON.stringify({ error: 'barber_staff_user_id and a 4-6 digit pin are required' }),
      {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      },
    );
  }

  const admin = createClient(url, serviceRoleKey);

  // The target must actually be a barber whose home branch (or an explicit branch assignment) the
  // caller is scoped to -- reusing the same two-source branch check pin-login's own SQL function
  // uses, called via RPC as the caller so it reads their own manage_barber_schedules capability.
  const { data: canManage } = await asCaller.rpc('has_capability', {
    cap: 'manage_barber_schedules',
  });
  if (!canManage) return new Response('Forbidden', { status: 403, headers: corsHeaders });

  const { data: barberRow } = await admin
    .from('barbers')
    .select('home_branch_id')
    .eq('staff_user_id', barber_staff_user_id)
    .single();
  if (!barberRow) return new Response('Barber not found', { status: 404, headers: corsHeaders });

  const { data: inScope } = await asCaller.rpc('in_branch_scope', {
    target_branch: barberRow.home_branch_id,
  });
  if (!inScope) return new Response('Forbidden', { status: 403, headers: corsHeaders });

  try {
    const { error: updateError } = await admin.rpc('set_barber_pin', {
      p_staff_user_id: barber_staff_user_id,
      p_pin: pin,
    });
    if (updateError) throw updateError;
    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
});
