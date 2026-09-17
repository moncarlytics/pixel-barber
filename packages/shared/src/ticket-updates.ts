// PRD section 34: "two staff members racing to edit the same ticket must have the second one
// rejected with the current state shown, not silently overwritten." queue_tickets.version is the
// mechanism -- every update is conditioned on the version the caller last read; a caller whose
// version is stale updates zero rows rather than clobbering a newer write. `version` itself is
// bumped exclusively by a database trigger (see the queue_tickets_auto_version migration) so this
// helper never sets it -- that also means every writer of this table, not just this helper, keeps
// the guarantee intact (the expire-no-show-grace-periods cron job included).
//
// A genuine write rejection (RLS, a check constraint, anything Postgres itself refuses) is a
// different failure mode from a stale version and is reported separately (`reason: 'rejected'`)
// so callers can distinguish "someone else already changed this" from "you're not allowed to do
// this" rather than treating both as the same conflict message.
import type { SupabaseClient } from '@supabase/supabase-js';

export type TicketUpdateResult<T> =
  | { success: true; ticket: T }
  | { success: false; reason: 'conflict' }
  | { success: false; reason: 'rejected'; error: unknown };

export async function updateTicketWithVersion<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  ticketId: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
): Promise<TicketUpdateResult<T>> {
  const { data, error } = await supabase
    .from('queue_tickets')
    .update(patch)
    .eq('id', ticketId)
    .eq('version', expectedVersion)
    .select()
    .maybeSingle();

  if (error) return { success: false, reason: 'rejected', error };
  if (!data) return { success: false, reason: 'conflict' };
  return { success: true, ticket: data as T };
}
