// Shape of branch_report() (supabase/migrations/20261008090100_branch_report.sql).
export interface ReportSummary {
  served: number;
  walk_ins: number;
  appointments: number;
  no_shows: number;
  no_show_rate: number | null;
  cancellations: number;
  cancellation_rate: number | null;
  avg_wait_min: number | null;
  median_wait_min: number | null;
  avg_service_min: number | null;
  rating_count: number;
  rating_average: number | null;
  est_takings_ghs: number;
  returning_rate: number | null;
}

export interface DailyRow {
  date: string;
  served: number;
  walk_ins: number;
  appointments: number;
  no_shows: number;
  cancellations: number;
  avg_wait_min: number | null;
  avg_service_min: number | null;
  rating_average: number | null;
  est_takings_ghs: number;
}

export interface HourRow {
  hour: number;
  avg_joined_per_day: number;
  avg_wait_min: number | null;
}

export interface BarberRow {
  barber_id: string;
  name: string;
  served: number;
  avg_service_min: number | null;
  no_shows: number;
  rating_average: number | null;
  est_takings_ghs: number;
}

export interface ServiceRow {
  name: string;
  served: number;
  share: number | null;
  avg_service_min: number | null;
  listed_duration_min: number;
  est_takings_ghs: number;
}

export interface ReasonRow {
  reason: string;
  count: number;
}

export interface BranchRow extends ReportSummary {
  branch_id: string;
  name: string;
}

export interface BranchReport {
  summary: ReportSummary;
  daily: DailyRow[];
  hours: HourRow[];
  barbers: BarberRow[];
  services: ServiceRow[];
  cancel_reasons: ReasonRow[];
  branches: BranchRow[] | null;
}
