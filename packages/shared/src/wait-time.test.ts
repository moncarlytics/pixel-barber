import { describe, expect, it } from 'vitest';
import { calculateWaitEstimate } from './wait-time';

describe('calculateWaitEstimate', () => {
  it('returns just the remaining time of the in-service ticket when nothing is ahead', () => {
    const result = calculateWaitEstimate({
      currentlyServing: { expectedDurationMin: 30, elapsedMin: 10 },
      ticketsAhead: [],
    });
    // 30 - 10 = 20 min remaining on the ticket in the chair; no queue ahead.
    expect(result.lowMin).toBe(20);
    expect(result.highMin).toBe(20);
    expect(result.confidence).toBe('high');
  });

  it("sums the remaining in-service time plus each ticket ahead's own expected duration", () => {
    const result = calculateWaitEstimate({
      currentlyServing: { expectedDurationMin: 30, elapsedMin: 20 },
      ticketsAhead: [{ expectedDurationMin: 25 }, { expectedDurationMin: 40 }],
    });
    // (30-20) + 25 + 40 = 75
    expect(result.lowMin).toBe(75);
    expect(result.highMin).toBe(75);
  });

  it('never returns a negative remaining time when a service is running long', () => {
    const result = calculateWaitEstimate({
      currentlyServing: { expectedDurationMin: 20, elapsedMin: 35 },
      ticketsAhead: [],
    });
    // Running 15 min over -- remaining time floors at 0, not -15.
    expect(result.lowMin).toBe(0);
    expect(result.highMin).toBe(0);
  });

  it('handles no one currently in service (queue empty ahead, or barber idle)', () => {
    const result = calculateWaitEstimate({
      currentlyServing: null,
      ticketsAhead: [{ expectedDurationMin: 30 }],
    });
    expect(result.lowMin).toBe(30);
    expect(result.highMin).toBe(30);
  });

  it('widens the range and lowers confidence when any duration in the chain is estimated, not from real history', () => {
    const result = calculateWaitEstimate({
      currentlyServing: { expectedDurationMin: 30, elapsedMin: 0, isHistorical: true },
      ticketsAhead: [{ expectedDurationMin: 25, isHistorical: false }],
    });
    // 30 + 25 = 55 base; the one non-historical duration widens the band by +/-20%, matching the
    // PRD's "range, not false precision" framing when data is thin.
    expect(result.lowMin).toBeLessThan(55);
    expect(result.highMin).toBeGreaterThan(55);
    expect(result.confidence).not.toBe('high');
  });

  it('reports variable confidence when every duration in the chain is a shop-wide default', () => {
    const result = calculateWaitEstimate({
      currentlyServing: { expectedDurationMin: 30, elapsedMin: 0, isHistorical: false },
      ticketsAhead: [{ expectedDurationMin: 25, isHistorical: false }],
    });
    expect(result.confidence).toBe('variable');
  });
});
