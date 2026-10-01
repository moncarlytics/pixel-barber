import { describe, expect, it } from 'vitest';
import { appointmentErrorKey } from './appointmentErrors';

describe('appointmentErrorKey', () => {
  it.each([
    ['slot_taken', 'slotTaken'],
    ['already_booked_that_day', 'alreadyBookedThatDay'],
    ['branch_closed', 'branchClosed'],
    ['too_soon', 'tooSoon'],
    ['too_far_ahead', 'tooFarAhead'],
    ['too_late', 'tooLate'],
    ['not_a_customer', 'notACustomer'],
  ])('maps %s', (code, key) => {
    expect(appointmentErrorKey(code)).toBe(key);
  });

  it('falls back to a generic message for anything else', () => {
    expect(appointmentErrorKey('Failed to fetch')).toBe('generic');
    expect(appointmentErrorKey(undefined)).toBe('generic');
  });
});
