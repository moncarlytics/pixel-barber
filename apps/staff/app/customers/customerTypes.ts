// Shapes of list_customers() and customer_detail()
// (supabase/migrations/20261008100000_customer_list.sql).
export type CustomerGroup = 'new' | 'returning' | 'frequent' | 'lapsed' | 'at_risk';

export interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  last_visit_at: string | null;
  visits: number;
  no_shows: number;
  avg_rating_given: number | null;
  group: CustomerGroup;
}

export interface CustomerList {
  rows: CustomerRow[];
  has_more: boolean;
}

export interface CustomerStats {
  visits: number;
  last_visit_at: string | null;
  appointments: number;
  no_shows: number;
  cancellations: number;
  late_cancellations: number;
  avg_rating_given: number | null;
  visits_last_90_days: number;
}

export interface CustomerDetail {
  customer: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    requires_confirmation_call: boolean;
    push_enabled: boolean;
    sms_backup_enabled: boolean;
    marketing_allowed: boolean;
  };
  stats: CustomerStats;
  group: CustomerGroup;
  branch_ids: string[];
  visits: {
    ticket_id: string;
    created_at: string;
    branch_name: string;
    service_name: string;
    barber_name: string | null;
    state: string;
    cancel_reason: string | null;
  }[];
  feedback: {
    created_at: string;
    branch_name: string;
    barber_name: string | null;
    overall_rating: number;
    comment: string | null;
  }[];
  messages: {
    id: string;
    created_at: string;
    branch_name: string | null;
    sent_by_name: string | null;
    text: string | null;
    status: string;
    failed_reason: string | null;
  }[];
}
