// Shape of branch_today() (supabase/migrations/20261008090000_today_dashboard.sql).
export interface TodayData {
  now: {
    waiting: number;
    called: number;
    in_service: number;
    appointments_to_come: number;
    barbers_available: number;
    barbers_busy: number;
  };
  today: {
    served: number;
    walk_ins: number;
    appointments: number;
    no_shows: number;
    cancellations: number;
    avg_wait_min: number | null;
    avg_service_min: number | null;
  };
  ratings: { count: number; average: number | null } | null;
  long_wait: { threshold_min: number; current_avg_wait_min: number | null; alert: boolean };
  updated_at: string;
}
