export type { Database } from './database.types';
export { createBrowserSupabaseClient } from './supabase/browser-client';
export { normalizeGhanaPhone } from './phone';
export { AVATAR_LIBRARY } from './avatars';
export type { Avatar } from './avatars';
export { calculateWaitEstimate } from './wait-time';
export type {
  WaitEstimateInput,
  WaitEstimateResult,
  DurationEstimate,
  CurrentlyServing,
  WaitConfidence,
} from './wait-time';
export { updateTicketWithVersion } from './ticket-updates';
export type { TicketUpdateResult } from './ticket-updates';
