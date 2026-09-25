// supabase/functions/_shared/http.ts
// JSON response helper for the staff invite functions; every response carries the CORS headers
// (browser fetches with an Authorization header are preflighted).
import { corsHeaders } from './cors.ts';

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
