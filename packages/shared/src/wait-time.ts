// PRD section 17: the estimate is the remaining time of whoever's currently in service (their
// service's expected duration minus elapsed time so far, floored at 0) plus the expected duration
// of each ticket ahead in the same queue -- using each service's own typical duration, and a
// barber's own historical average where they have enough completed-service history for it
// (isHistorical=true), falling back to services.default_duration_minutes (isHistorical=false)
// otherwise. A range, not false precision: when any duration in the chain isn't backed by real
// history, the band widens and confidence drops, rather than showing a number more certain than
// the underlying data actually is.

export interface DurationEstimate {
  expectedDurationMin: number;
  /** true when this duration came from barber_service_stats history, false when it's services.default_duration_minutes */
  isHistorical?: boolean;
}

export interface CurrentlyServing extends DurationEstimate {
  elapsedMin: number;
}

export interface WaitEstimateInput {
  currentlyServing: CurrentlyServing | null;
  ticketsAhead: DurationEstimate[];
}

export type WaitConfidence = 'high' | 'moderate' | 'variable';

export interface WaitEstimateResult {
  lowMin: number;
  highMin: number;
  confidence: WaitConfidence;
}

export function calculateWaitEstimate(input: WaitEstimateInput): WaitEstimateResult {
  const remainingCurrent = input.currentlyServing
    ? Math.max(0, input.currentlyServing.expectedDurationMin - input.currentlyServing.elapsedMin)
    : 0;

  const baseMin =
    remainingCurrent + input.ticketsAhead.reduce((sum, t) => sum + t.expectedDurationMin, 0);

  const allEstimates = input.currentlyServing
    ? [input.currentlyServing, ...input.ticketsAhead]
    : input.ticketsAhead;
  const historicalCount = allEstimates.filter((e) => e.isHistorical).length;
  const explicitlyNonHistoricalCount = allEstimates.filter((e) => e.isHistorical === false).length;

  let confidence: WaitConfidence;
  let widenFraction: number;
  if (allEstimates.length === 0 || explicitlyNonHistoricalCount === 0) {
    confidence = 'high';
    widenFraction = 0;
  } else if (historicalCount > 0) {
    confidence = 'moderate';
    widenFraction = 0.2;
  } else {
    confidence = 'variable';
    widenFraction = 0.2;
  }

  const lowMin = Math.max(0, Math.round(baseMin * (1 - widenFraction)));
  const highMin = Math.round(baseMin * (1 + widenFraction));

  return { lowMin, highMin, confidence };
}
