// supabase/functions/_shared/cors.ts
// Shared CORS headers for tickets-join and tickets-walk-in. Both require a custom Authorization
// header, which makes every browser fetch() to them a non-simple cross-origin request -- the
// browser always sends an OPTIONS preflight first, and every actual response (success or error)
// still needs these headers or the browser blocks it after the preflight succeeds.
export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
