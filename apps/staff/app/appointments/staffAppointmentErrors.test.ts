import { describe, expect, it } from 'vitest';
import { staffAppointmentErrorKey } from './staffAppointmentErrors';

describe('staffAppointmentErrorKey', () => {
  it.each([
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
  ])('maps %s', (code, key) => {
    expect(staffAppointmentErrorKey(code)).toBe(key);
  });

  it('falls back to generic, including for prototype names', () => {
    expect(staffAppointmentErrorKey('boom')).toBe('generic');
    expect(staffAppointmentErrorKey(undefined)).toBe('generic');
    expect(staffAppointmentErrorKey('constructor')).toBe('generic');
  });
});
