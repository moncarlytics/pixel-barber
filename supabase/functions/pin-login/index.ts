// supabase/functions/pin-login/index.ts
// Backend schema section 3.3 in full. A PIN mints a REAL Supabase session -- not a client-side
// view switch -- so every RLS policy applies exactly as it would to a personal-device login. This
// is why the token exchange happens server-side under the service-role key: `generateLink`/
// `verifyOtp` must never be reachable from any client bundle for a staff identity (the exact same
// constraint backend-schema 3.4 states for the staff-invite flow).
import { createClient } from '@supabase/supabase-js';
import { corsHeaders } from '../_shared/cors.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405, headers: corsHeaders });
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
  const { branch_id, pin } = body;
  if (!branch_id || !pin) {
    return new Response(JSON.stringify({ error: 'branch_id and pin are required' }), {
      status: 400,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const url = Deno.env.get('SUPABASE_URL')!;
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const admin = createClient(url, serviceRoleKey);

  // Find every barber staff_user with a pin_hash set, whose bcrypt hash matches the submitted PIN,
  // then separately confirm they're legitimately at THIS branch -- never trust branch_id alone, and
  // never do the bcrypt comparison in application code (crypt() runs in Postgres, pin_hash never
  // leaves the database in a form that could be compared client-side).
  //
  // verify_barber_pin is declared `returns table (...)`, and a `returns table` RPC comes back
  // through the Supabase JS client as an ARRAY of row objects, not a single row -- confirmed by
  // this same repo's precedent for another `returns table` RPC (get_update_grants, consumed as
  // `data as {...}[]` in tests/db/barber-self-update-grants.test.ts). The SQL's own `limit 1` means
  // at most one element, so we take candidates?.[0] and treat an empty array the same as no match.
  const { data: candidates, error: candidateError } = await admin.rpc('verify_barber_pin', {
    p_branch_id: branch_id,
    p_pin: pin,
  });
  const candidate = candidates?.[0];
  if (candidateError || !candidates || candidates.length === 0 || !candidate) {
    return new Response(JSON.stringify({ error: 'Invalid PIN' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const { data: linkData, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: candidate.email,
  });
  if (linkError || !linkData) {
    return new Response(JSON.stringify({ error: 'Login failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const asAnon = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!);
  const { data: sessionData, error: verifyError } = await asAnon.auth.verifyOtp({
    token_hash: linkData.properties.hashed_token,
    type: 'magiclink',
  });
  if (verifyError || !sessionData.session) {
    return new Response(JSON.stringify({ error: 'Login failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  return new Response(
    JSON.stringify({
      access_token: sessionData.session.access_token,
      refresh_token: sessionData.session.refresh_token,
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  );
});
