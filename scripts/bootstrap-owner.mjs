// scripts/bootstrap-owner.mjs
// One-time operational step per PRD section 46.1: "the very first Owner account is created
// once, manually... It is the one staff account in the entire system that does not originate
// from an invite." Every account after this one must go through the staff-invite flow (section
// 46.2, Phase 1's implementation plan does not build that flow — Phase 8 or an earlier ad-hoc
// Edge Function would; this script is deliberately the only exception).
// NOTE: plain `dotenv/config` only auto-loads `.env`, not `.env.local` — this project
// keeps real values in `.env.local` (matching both apps' convention), so we point
// dotenv at it explicitly rather than relying on the default `.env` lookup.
import { config } from 'dotenv';
import { createClient } from '@supabase/supabase-js';

config({ path: '.env.local' });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const [, , email, password, name] = process.argv;

if (!url || !serviceRoleKey) {
  throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
}
if (!email || !password || !name) {
  throw new Error('Usage: node scripts/bootstrap-owner.mjs <email> <password> "<name>"');
}

const admin = createClient(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const { data: userData, error: userError } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
});
if (userError) throw userError;

const { data: staffRow, error: staffError } = await admin
  .from('staff_users')
  .insert({
    auth_user_id: userData.user.id,
    name,
    email,
    role: 'owner',
    invite_status: 'accepted',
    invite_accepted_at: new Date().toISOString(),
  })
  .select()
  .single();
if (staffError) throw staffError;

console.log('Owner staff_users row created:', staffRow.id);
