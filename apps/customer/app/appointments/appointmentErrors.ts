/** Message keys (in the `Appointments` namespace) for the appointment functions' error strings. */
export type AppointmentErrorKey =
  | 'slotTaken'
  | 'alreadyBookedThatDay'
  | 'branchClosed'
  | 'tooSoon'
  | 'tooFarAhead'
  | 'tooLate'
  | 'notACustomer'
  | 'tooEarly'
  | 'notFound'
  | 'generic';

const KEYS: Record<string, AppointmentErrorKey> = {
  slot_taken: 'slotTaken',
  already_booked_that_day: 'alreadyBookedThatDay',
  branch_closed: 'branchClosed',
  too_soon: 'tooSoon',
  too_far_ahead: 'tooFarAhead',
  too_late: 'tooLate',
  not_a_customer: 'notACustomer',
  too_early: 'tooEarly',
  not_found: 'notFound',
};

export function appointmentErrorKey(message: string | undefined): AppointmentErrorKey {
  return (message && KEYS[message]) || 'generic';
}
