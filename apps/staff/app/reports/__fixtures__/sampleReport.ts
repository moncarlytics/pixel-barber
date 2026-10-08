// A small report (two days, one barber, one service) for the table and export builder tests.
import type { BranchReport, ReportSummary } from '../reportTypes';

const summary: ReportSummary = {
  served: 3,
  walk_ins: 2,
  appointments: 1,
  no_shows: 1,
  no_show_rate: 25,
  cancellations: 1,
  cancellation_rate: 20,
  avg_wait_min: 18,
  median_wait_min: 15,
  avg_service_min: 25,
  rating_count: 2,
  rating_average: 3.5,
  est_takings_ghs: 1250,
  returning_rate: 33.3,
};

export const sampleReport: BranchReport = {
  summary,
  daily: [
    {
      date: '2026-09-28',
      served: 2,
      walk_ins: 2,
      appointments: 0,
      no_shows: 1,
      cancellations: 0,
      avg_wait_min: 25,
      avg_service_min: 25,
      rating_average: 3.5,
      est_takings_ghs: 900,
    },
    {
      date: '2026-09-29',
      served: 1,
      walk_ins: 0,
      appointments: 1,
      no_shows: 0,
      cancellations: 1,
      avg_wait_min: null,
      avg_service_min: null,
      rating_average: null,
      est_takings_ghs: 350,
    },
  ],
  hours: [
    { hour: 10, avg_joined_per_day: 2, avg_wait_min: 25 },
    { hour: 14, avg_joined_per_day: 1, avg_wait_min: null },
  ],
  barbers: [
    {
      barber_id: 'b1',
      name: 'Kofi',
      served: 3,
      avg_service_min: 25,
      no_shows: 1,
      rating_average: 3.5,
      est_takings_ghs: 1250,
    },
  ],
  services: [
    {
      name: 'Haircut',
      served: 3,
      share: 100,
      avg_service_min: 25,
      listed_duration_min: 30,
      est_takings_ghs: 1250,
    },
  ],
  cancel_reasons: [{ reason: 'cant_make_it', count: 1 }],
  branches: null,
};

export const sampleAllBranches: BranchReport = {
  ...sampleReport,
  branches: [
    { ...summary, branch_id: 'br1', name: 'Osu' },
    {
      ...summary,
      branch_id: 'br2',
      name: 'Tema',
      served: 0,
      est_takings_ghs: 0,
      avg_wait_min: null,
    },
  ],
};
