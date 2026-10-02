/** Message keys (in `StaffAppointments.errors`) for the staff appointment functions' errors. */
export type StaffAppointmentErrorKey =
  | 'slotTaken'
  | 'alreadyBookedThatDay'
  | 'branchClosed'
  | 'tooSoon'
  | 'tooFarAhead'
  | 'tooLate'
  | 'notAllowed'
  | 'alreadyConverted'
  | 'invalidPhone'
  | 'notFound'
  | 'generic';

const KEYS = new Map<string, StaffAppointmentErrorKey>([
  ['slot_taken', 'slotTaken'],
  ['already_booked_that_day', 'alreadyBookedThatDay'],
  ['branch_closed', 'branchClosed'],
  ['too_soon', 'tooSoon'],
  ['too_far_ahead', 'tooFarAhead'],
  ['too_late', 'tooLate'],
  ['not_allowed', 'notAllowed'],
  ['already_converted', 'alreadyConverted'],
  ['invalid_phone', 'invalidPhone'],
  ['not_found', 'notFound'],
]);

export function staffAppointmentErrorKey(message: string | undefined): StaffAppointmentErrorKey {
  return (message && KEYS.get(message)) || 'generic';
}
