// PRD section 34: "two staff members racing to edit the same ticket must have the second one
// rejected with the current state shown, not silently overwritten." queue_tickets.version is the
// mechanism -- every update is conditioned on the version the caller last read, and increments on
// success; a caller whose version is stale updates zero rows rather than clobbering a newer write.
import type { SupabaseClient } from '@supabase/supabase-js';

export type TicketUpdateResult<T> = { success: true; ticket: T } | { success: false };

export async function updateTicketWithVersion<T = Record<string, unknown>>(
  supabase: SupabaseClient,
  ticketId: string,
  expectedVersion: number,
  patch: Record<string, unknown>,
): Promise<TicketUpdateResult<T>> {
  const { data, error } = await supabase
    .from('queue_tickets')
    .update({ ...patch, version: expectedVersion + 1 })
    .eq('id', ticketId)
    .eq('version', expectedVersion)
    .select()
    .maybeSingle();

  if (error) throw error;
  if (!data) return { success: false };
  return { success: true, ticket: data as T };
}
