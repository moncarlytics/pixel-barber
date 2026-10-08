export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: '14.5';
  };
  public: {
    Tables: {
      appointments: {
        Row: {
          branch_id: string;
          branch_service_id: string;
          cancel_reason: Database['public']['Enums']['cancel_reason'] | null;
          cancelled_at: string | null;
          check_in_method: Database['public']['Enums']['check_in_method'] | null;
          checked_in_at: string | null;
          created_at: string;
          created_by: Database['public']['Enums']['ticket_created_by'];
          created_by_staff_id: string | null;
          customer_id: string;
          id: string;
          preferred_barber_id: string | null;
          scheduled_end: string;
          scheduled_start: string;
          status: Database['public']['Enums']['appointment_status'];
          updated_at: string;
          version: number;
        };
        Insert: {
          branch_id: string;
          branch_service_id: string;
          cancel_reason?: Database['public']['Enums']['cancel_reason'] | null;
          cancelled_at?: string | null;
          check_in_method?: Database['public']['Enums']['check_in_method'] | null;
          checked_in_at?: string | null;
          created_at?: string;
          created_by: Database['public']['Enums']['ticket_created_by'];
          created_by_staff_id?: string | null;
          customer_id: string;
          id?: string;
          preferred_barber_id?: string | null;
          scheduled_end: string;
          scheduled_start: string;
          status?: Database['public']['Enums']['appointment_status'];
          updated_at?: string;
          version?: number;
        };
        Update: {
          branch_id?: string;
          branch_service_id?: string;
          cancel_reason?: Database['public']['Enums']['cancel_reason'] | null;
          cancelled_at?: string | null;
          check_in_method?: Database['public']['Enums']['check_in_method'] | null;
          checked_in_at?: string | null;
          created_at?: string;
          created_by?: Database['public']['Enums']['ticket_created_by'];
          created_by_staff_id?: string | null;
          customer_id?: string;
          id?: string;
          preferred_barber_id?: string | null;
          scheduled_end?: string;
          scheduled_start?: string;
          status?: Database['public']['Enums']['appointment_status'];
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'appointments_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'appointments_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'appointments_branch_service_id_fkey';
            columns: ['branch_service_id'];
            isOneToOne: false;
            referencedRelation: 'branch_services';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'appointments_created_by_staff_id_fkey';
            columns: ['created_by_staff_id'];
            isOneToOne: false;
            referencedRelation: 'staff_users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'appointments_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customer_segments';
            referencedColumns: ['customer_id'];
          },
          {
            foreignKeyName: 'appointments_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'appointments_preferred_barber_id_fkey';
            columns: ['preferred_barber_id'];
            isOneToOne: false;
            referencedRelation: 'barbers';
            referencedColumns: ['id'];
          },
        ];
      };
      audit_log: {
        Row: {
          action: string;
          actor_staff_id: string | null;
          actor_type: string;
          after_value: Json | null;
          before_value: Json | null;
          created_at: string;
          entity_id: string;
          entity_type: string;
          id: string;
          result: string;
        };
        Insert: {
          action: string;
          actor_staff_id?: string | null;
          actor_type: string;
          after_value?: Json | null;
          before_value?: Json | null;
          created_at?: string;
          entity_id: string;
          entity_type: string;
          id?: string;
          result: string;
        };
        Update: {
          action?: string;
          actor_staff_id?: string | null;
          actor_type?: string;
          after_value?: Json | null;
          before_value?: Json | null;
          created_at?: string;
          entity_id?: string;
          entity_type?: string;
          id?: string;
          result?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'audit_log_actor_staff_id_fkey';
            columns: ['actor_staff_id'];
            isOneToOne: false;
            referencedRelation: 'staff_users';
            referencedColumns: ['id'];
          },
        ];
      };
      barber_days_off: {
        Row: { barber_id: string; off_date: string };
        Insert: { barber_id: string; off_date: string };
        Update: { barber_id?: string; off_date?: string };
        Relationships: [];
      };
      barber_schedule: {
        Row: {
          barber_id: string;
          branch_id: string;
          break_end: string | null;
          break_start: string | null;
          id: string;
          is_manual: boolean;
          shift_end: string;
          shift_start: string;
          work_date: string;
        };
        Insert: {
          barber_id: string;
          branch_id: string;
          break_end?: string | null;
          break_start?: string | null;
          id?: string;
          is_manual?: boolean;
          shift_end: string;
          shift_start: string;
          work_date: string;
        };
        Update: {
          barber_id?: string;
          branch_id?: string;
          break_end?: string | null;
          break_start?: string | null;
          id?: string;
          is_manual?: boolean;
          shift_end?: string;
          shift_start?: string;
          work_date?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'barber_schedule_barber_id_fkey';
            columns: ['barber_id'];
            isOneToOne: false;
            referencedRelation: 'barbers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'barber_schedule_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'barber_schedule_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
        ];
      };
      barber_service_stats: {
        Row: {
          avg_duration_seconds: number | null;
          barber_id: string;
          completed_count: number;
          service_id: string;
          updated_at: string;
        };
        Insert: {
          avg_duration_seconds?: number | null;
          barber_id: string;
          completed_count?: number;
          service_id: string;
          updated_at?: string;
        };
        Update: {
          avg_duration_seconds?: number | null;
          barber_id?: string;
          completed_count?: number;
          service_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'barber_service_stats_barber_id_fkey';
            columns: ['barber_id'];
            isOneToOne: false;
            referencedRelation: 'barbers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'barber_service_stats_service_id_fkey';
            columns: ['service_id'];
            isOneToOne: false;
            referencedRelation: 'services';
            referencedColumns: ['id'];
          },
        ];
      };
      barber_skills: {
        Row: {
          barber_id: string;
          service_id: string;
        };
        Insert: {
          barber_id: string;
          service_id: string;
        };
        Update: {
          barber_id?: string;
          service_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'barber_skills_barber_id_fkey';
            columns: ['barber_id'];
            isOneToOne: false;
            referencedRelation: 'barbers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'barber_skills_service_id_fkey';
            columns: ['service_id'];
            isOneToOne: false;
            referencedRelation: 'services';
            referencedColumns: ['id'];
          },
        ];
      };
      barber_weekly_hours: {
        Row: {
          barber_id: string;
          branch_id: string;
          day_of_week: number;
          id: string;
          shift_end: string;
          shift_start: string;
        };
        Insert: {
          barber_id: string;
          branch_id: string;
          day_of_week: number;
          id?: string;
          shift_end: string;
          shift_start: string;
        };
        Update: {
          barber_id?: string;
          branch_id?: string;
          day_of_week?: number;
          id?: string;
          shift_end?: string;
          shift_start?: string;
        };
        Relationships: [];
      };
      barbers: {
        Row: {
          average_rating: number | null;
          created_at: string;
          current_ticket_id: string | null;
          home_branch_id: string;
          id: string;
          staff_user_id: string;
          status: Database['public']['Enums']['barber_status'];
          updated_at: string;
        };
        Insert: {
          average_rating?: number | null;
          created_at?: string;
          current_ticket_id?: string | null;
          home_branch_id: string;
          id?: string;
          staff_user_id: string;
          status?: Database['public']['Enums']['barber_status'];
          updated_at?: string;
        };
        Update: {
          average_rating?: number | null;
          created_at?: string;
          current_ticket_id?: string | null;
          home_branch_id?: string;
          id?: string;
          staff_user_id?: string;
          status?: Database['public']['Enums']['barber_status'];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'barbers_current_ticket_id_fkey';
            columns: ['current_ticket_id'];
            isOneToOne: false;
            referencedRelation: 'queue_tickets';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'barbers_home_branch_id_fkey';
            columns: ['home_branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'barbers_home_branch_id_fkey';
            columns: ['home_branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'barbers_staff_user_id_fkey';
            columns: ['staff_user_id'];
            isOneToOne: true;
            referencedRelation: 'staff_users';
            referencedColumns: ['id'];
          },
        ];
      };
      branch_closures: {
        Row: {
          branch_id: string;
          closure_date: string;
          id: string;
          reason: string | null;
        };
        Insert: {
          branch_id: string;
          closure_date: string;
          id?: string;
          reason?: string | null;
        };
        Update: {
          branch_id?: string;
          closure_date?: string;
          id?: string;
          reason?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'branch_closures_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'branch_closures_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
        ];
      };
      branch_hours: {
        Row: {
          branch_id: string;
          closes_at: string | null;
          day_of_week: number;
          id: string;
          is_closed: boolean;
          opens_at: string | null;
        };
        Insert: {
          branch_id: string;
          closes_at?: string | null;
          day_of_week: number;
          id?: string;
          is_closed?: boolean;
          opens_at?: string | null;
        };
        Update: {
          branch_id?: string;
          closes_at?: string | null;
          day_of_week?: number;
          id?: string;
          is_closed?: boolean;
          opens_at?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'branch_hours_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'branch_hours_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
        ];
      };
      branch_service_prices: {
        Row: {
          branch_service_id: string;
          created_at: string;
          effective_from: string;
          effective_until: string | null;
          id: string;
          is_promo: boolean;
          price_ghs: number;
        };
        Insert: {
          branch_service_id: string;
          created_at?: string;
          effective_from: string;
          effective_until?: string | null;
          id?: string;
          is_promo?: boolean;
          price_ghs: number;
        };
        Update: {
          branch_service_id?: string;
          created_at?: string;
          effective_from?: string;
          effective_until?: string | null;
          id?: string;
          is_promo?: boolean;
          price_ghs?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'branch_service_prices_branch_service_id_fkey';
            columns: ['branch_service_id'];
            isOneToOne: false;
            referencedRelation: 'branch_services';
            referencedColumns: ['id'];
          },
        ];
      };
      branch_services: {
        Row: {
          branch_id: string;
          created_at: string;
          duration_minutes_override: number | null;
          id: string;
          is_active: boolean;
          service_id: string;
          updated_at: string;
        };
        Insert: {
          branch_id: string;
          created_at?: string;
          duration_minutes_override?: number | null;
          id?: string;
          is_active?: boolean;
          service_id: string;
          updated_at?: string;
        };
        Update: {
          branch_id?: string;
          created_at?: string;
          duration_minutes_override?: number | null;
          id?: string;
          is_active?: boolean;
          service_id?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'branch_services_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'branch_services_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'branch_services_service_id_fkey';
            columns: ['service_id'];
            isOneToOne: false;
            referencedRelation: 'services';
            referencedColumns: ['id'];
          },
        ];
      };
      branch_ticket_counters: {
        Row: {
          branch_id: string;
          last_seq: number;
          ticket_date: string;
        };
        Insert: {
          branch_id: string;
          last_seq?: number;
          ticket_date: string;
        };
        Update: {
          branch_id?: string;
          last_seq?: number;
          ticket_date?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'branch_ticket_counters_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'branch_ticket_counters_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
        ];
      };
      branches: {
        Row: {
          address: string;
          branch_code: string;
          business_id: string;
          created_at: string;
          geofence_radius_m: number;
          id: string;
          is_temporarily_closed: boolean;
          latitude: number;
          long_wait_warning_minutes: number;
          longitude: number;
          max_queue_size: number | null;
          name: string;
          no_show_grace_minutes: number;
          phone_e164: string | null;
          updated_at: string;
        };
        Insert: {
          address: string;
          branch_code: string;
          business_id: string;
          created_at?: string;
          geofence_radius_m?: number;
          id?: string;
          is_temporarily_closed?: boolean;
          latitude: number;
          long_wait_warning_minutes?: number;
          longitude: number;
          max_queue_size?: number | null;
          name: string;
          no_show_grace_minutes?: number;
          phone_e164?: string | null;
          updated_at?: string;
        };
        Update: {
          address?: string;
          branch_code?: string;
          business_id?: string;
          created_at?: string;
          geofence_radius_m?: number;
          id?: string;
          is_temporarily_closed?: boolean;
          latitude?: number;
          long_wait_warning_minutes?: number;
          longitude?: number;
          max_queue_size?: number | null;
          name?: string;
          no_show_grace_minutes?: number;
          phone_e164?: string | null;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'branches_business_id_fkey';
            columns: ['business_id'];
            isOneToOne: false;
            referencedRelation: 'businesses';
            referencedColumns: ['id'];
          },
        ];
      };
      businesses: {
        Row: {
          created_at: string;
          default_currency: string;
          default_policies: Json;
          id: string;
          name: string;
        };
        Insert: {
          created_at?: string;
          default_currency?: string;
          default_policies?: Json;
          id?: string;
          name: string;
        };
        Update: {
          created_at?: string;
          default_currency?: string;
          default_policies?: Json;
          id?: string;
          name?: string;
        };
        Relationships: [];
      };
      capabilities: {
        Row: {
          description: string;
          key: string;
        };
        Insert: {
          description: string;
          key: string;
        };
        Update: {
          description?: string;
          key?: string;
        };
        Relationships: [];
      };
      consents: {
        Row: {
          consent_type: Database['public']['Enums']['consent_type'];
          created_at: string;
          customer_id: string;
          granted: boolean;
          id: string;
          source: string;
        };
        Insert: {
          consent_type: Database['public']['Enums']['consent_type'];
          created_at?: string;
          customer_id: string;
          granted: boolean;
          id?: string;
          source: string;
        };
        Update: {
          consent_type?: Database['public']['Enums']['consent_type'];
          created_at?: string;
          customer_id?: string;
          granted?: boolean;
          id?: string;
          source?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'consents_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customer_segments';
            referencedColumns: ['customer_id'];
          },
          {
            foreignKeyName: 'consents_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id'];
          },
        ];
      };
      customers: {
        Row: {
          anonymized_at: string | null;
          auth_user_id: string | null;
          avatar_key: string | null;
          created_at: string;
          email: string | null;
          id: string;
          is_anonymized: boolean;
          last_activity_at: string;
          late_cancellation_count: number;
          name: string;
          no_show_count: number;
          phone_e164: string | null;
          preferred_branch_id: string | null;
          push_enabled: boolean;
          push_lead_minutes_primary: number;
          push_lead_minutes_secondary: number;
          requires_confirmation_call: boolean;
          sms_backup_enabled: boolean;
          updated_at: string;
        };
        Insert: {
          anonymized_at?: string | null;
          auth_user_id?: string | null;
          avatar_key?: string | null;
          created_at?: string;
          email?: string | null;
          id?: string;
          is_anonymized?: boolean;
          last_activity_at?: string;
          late_cancellation_count?: number;
          name: string;
          no_show_count?: number;
          phone_e164?: string | null;
          preferred_branch_id?: string | null;
          push_enabled?: boolean;
          push_lead_minutes_primary?: number;
          push_lead_minutes_secondary?: number;
          requires_confirmation_call?: boolean;
          sms_backup_enabled?: boolean;
          updated_at?: string;
        };
        Update: {
          anonymized_at?: string | null;
          auth_user_id?: string | null;
          avatar_key?: string | null;
          created_at?: string;
          email?: string | null;
          id?: string;
          is_anonymized?: boolean;
          last_activity_at?: string;
          late_cancellation_count?: number;
          name?: string;
          no_show_count?: number;
          phone_e164?: string | null;
          preferred_branch_id?: string | null;
          push_enabled?: boolean;
          push_lead_minutes_primary?: number;
          push_lead_minutes_secondary?: number;
          requires_confirmation_call?: boolean;
          sms_backup_enabled?: boolean;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'customers_preferred_branch_id_fkey';
            columns: ['preferred_branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'customers_preferred_branch_id_fkey';
            columns: ['preferred_branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
        ];
      };
      feedback: {
        Row: {
          barber_id: string;
          barber_professionalism_rating: number | null;
          branch_id: string;
          cleanliness_rating: number | null;
          comment: string | null;
          created_at: string;
          customer_id: string;
          gemini_processed_at: string | null;
          gemini_themes: string[] | null;
          id: string;
          overall_rating: number;
          seen_at: string | null;
          seen_by_staff_id: string | null;
          service_quality_rating: number | null;
          ticket_id: string;
          value_rating: number | null;
          waiting_experience_rating: number | null;
        };
        Insert: {
          barber_id: string;
          barber_professionalism_rating?: number | null;
          branch_id: string;
          cleanliness_rating?: number | null;
          comment?: string | null;
          created_at?: string;
          customer_id: string;
          gemini_processed_at?: string | null;
          gemini_themes?: string[] | null;
          id?: string;
          overall_rating: number;
          seen_at?: string | null;
          seen_by_staff_id?: string | null;
          service_quality_rating?: number | null;
          ticket_id: string;
          value_rating?: number | null;
          waiting_experience_rating?: number | null;
        };
        Update: {
          barber_id?: string;
          barber_professionalism_rating?: number | null;
          branch_id?: string;
          cleanliness_rating?: number | null;
          comment?: string | null;
          created_at?: string;
          customer_id?: string;
          gemini_processed_at?: string | null;
          gemini_themes?: string[] | null;
          id?: string;
          overall_rating?: number;
          seen_at?: string | null;
          seen_by_staff_id?: string | null;
          service_quality_rating?: number | null;
          ticket_id?: string;
          value_rating?: number | null;
          waiting_experience_rating?: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'feedback_barber_id_fkey';
            columns: ['barber_id'];
            isOneToOne: false;
            referencedRelation: 'barbers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'feedback_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'feedback_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'feedback_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customer_segments';
            referencedColumns: ['customer_id'];
          },
          {
            foreignKeyName: 'feedback_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'feedback_ticket_id_fkey';
            columns: ['ticket_id'];
            isOneToOne: true;
            referencedRelation: 'queue_tickets';
            referencedColumns: ['id'];
          },
        ];
      };
      notifications: {
        Row: {
          channel: Database['public']['Enums']['notification_channel'];
          created_at: string;
          delivered_at: string | null;
          dispatch_attempts: number;
          dispatch_claimed_at: string | null;
          failed_reason: string | null;
          id: string;
          notification_type: string;
          payload: Json;
          recipient_id: string;
          recipient_type: Database['public']['Enums']['notification_recipient_type'];
          related_appointment_id: string | null;
          related_ticket_id: string | null;
          sent_at: string | null;
          status: Database['public']['Enums']['notification_status'];
        };
        Insert: {
          channel: Database['public']['Enums']['notification_channel'];
          created_at?: string;
          delivered_at?: string | null;
          dispatch_attempts?: number;
          dispatch_claimed_at?: string | null;
          failed_reason?: string | null;
          id?: string;
          notification_type: string;
          payload?: Json;
          recipient_id: string;
          recipient_type: Database['public']['Enums']['notification_recipient_type'];
          related_appointment_id?: string | null;
          related_ticket_id?: string | null;
          sent_at?: string | null;
          status?: Database['public']['Enums']['notification_status'];
        };
        Update: {
          channel?: Database['public']['Enums']['notification_channel'];
          created_at?: string;
          delivered_at?: string | null;
          dispatch_attempts?: number;
          dispatch_claimed_at?: string | null;
          failed_reason?: string | null;
          id?: string;
          notification_type?: string;
          payload?: Json;
          recipient_id?: string;
          recipient_type?: Database['public']['Enums']['notification_recipient_type'];
          related_appointment_id?: string | null;
          related_ticket_id?: string | null;
          sent_at?: string | null;
          status?: Database['public']['Enums']['notification_status'];
        };
        Relationships: [
          {
            foreignKeyName: 'notifications_related_appointment_id_fkey';
            columns: ['related_appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'notifications_related_ticket_id_fkey';
            columns: ['related_ticket_id'];
            isOneToOne: false;
            referencedRelation: 'queue_tickets';
            referencedColumns: ['id'];
          },
        ];
      };
      push_subscriptions: {
        Row: {
          auth_key: string;
          created_at: string;
          customer_id: string;
          endpoint: string;
          id: string;
          last_seen_at: string;
          p256dh_key: string;
          user_agent: string | null;
        };
        Insert: {
          auth_key: string;
          created_at?: string;
          customer_id: string;
          endpoint: string;
          id?: string;
          last_seen_at?: string;
          p256dh_key: string;
          user_agent?: string | null;
        };
        Update: {
          auth_key?: string;
          created_at?: string;
          customer_id?: string;
          endpoint?: string;
          id?: string;
          last_seen_at?: string;
          p256dh_key?: string;
          user_agent?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: 'push_subscriptions_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customer_segments';
            referencedColumns: ['customer_id'];
          },
          {
            foreignKeyName: 'push_subscriptions_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id'];
          },
        ];
      };
      queue_events: {
        Row: {
          actor_id: string | null;
          actor_type: string;
          after_state: Json | null;
          before_state: Json | null;
          created_at: string;
          event_type: string;
          id: string;
          metadata: Json;
          ticket_id: string;
        };
        Insert: {
          actor_id?: string | null;
          actor_type: string;
          after_state?: Json | null;
          before_state?: Json | null;
          created_at?: string;
          event_type: string;
          id?: string;
          metadata?: Json;
          ticket_id: string;
        };
        Update: {
          actor_id?: string | null;
          actor_type?: string;
          after_state?: Json | null;
          before_state?: Json | null;
          created_at?: string;
          event_type?: string;
          id?: string;
          metadata?: Json;
          ticket_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'queue_events_ticket_id_fkey';
            columns: ['ticket_id'];
            isOneToOne: false;
            referencedRelation: 'queue_tickets';
            referencedColumns: ['id'];
          },
        ];
      };
      queue_tickets: {
        Row: {
          appointment_id: string | null;
          assigned_barber_id: string | null;
          branch_id: string;
          branch_service_id: string;
          called_at: string | null;
          cancel_reason: Database['public']['Enums']['cancel_reason'] | null;
          cancelled_at: string | null;
          check_in_method: Database['public']['Enums']['check_in_method'] | null;
          checked_in_at: string | null;
          completed_at: string | null;
          confirmed_at: string | null;
          created_at: string;
          created_by: Database['public']['Enums']['ticket_created_by'];
          created_by_staff_id: string | null;
          customer_id: string;
          estimated_wait_high_min: number | null;
          estimated_wait_low_min: number | null;
          grace_period_expires_at: string | null;
          id: string;
          is_pooled: boolean;
          is_stepped_out: boolean;
          no_show_at: string | null;
          position: number | null;
          preferred_barber_id: string | null;
          service_started_at: string | null;
          state: Database['public']['Enums']['ticket_state'];
          stepped_out_at: string | null;
          ticket_number: string;
          updated_at: string;
          version: number;
        };
        Insert: {
          appointment_id?: string | null;
          assigned_barber_id?: string | null;
          branch_id: string;
          branch_service_id: string;
          called_at?: string | null;
          cancel_reason?: Database['public']['Enums']['cancel_reason'] | null;
          cancelled_at?: string | null;
          check_in_method?: Database['public']['Enums']['check_in_method'] | null;
          checked_in_at?: string | null;
          completed_at?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
          created_by: Database['public']['Enums']['ticket_created_by'];
          created_by_staff_id?: string | null;
          customer_id: string;
          estimated_wait_high_min?: number | null;
          estimated_wait_low_min?: number | null;
          grace_period_expires_at?: string | null;
          id?: string;
          is_pooled?: boolean;
          is_stepped_out?: boolean;
          no_show_at?: string | null;
          position?: number | null;
          preferred_barber_id?: string | null;
          service_started_at?: string | null;
          state?: Database['public']['Enums']['ticket_state'];
          stepped_out_at?: string | null;
          ticket_number: string;
          updated_at?: string;
          version?: number;
        };
        Update: {
          appointment_id?: string | null;
          assigned_barber_id?: string | null;
          branch_id?: string;
          branch_service_id?: string;
          called_at?: string | null;
          cancel_reason?: Database['public']['Enums']['cancel_reason'] | null;
          cancelled_at?: string | null;
          check_in_method?: Database['public']['Enums']['check_in_method'] | null;
          checked_in_at?: string | null;
          completed_at?: string | null;
          confirmed_at?: string | null;
          created_at?: string;
          created_by?: Database['public']['Enums']['ticket_created_by'];
          created_by_staff_id?: string | null;
          customer_id?: string;
          estimated_wait_high_min?: number | null;
          estimated_wait_low_min?: number | null;
          grace_period_expires_at?: string | null;
          id?: string;
          is_pooled?: boolean;
          is_stepped_out?: boolean;
          no_show_at?: string | null;
          position?: number | null;
          preferred_barber_id?: string | null;
          service_started_at?: string | null;
          state?: Database['public']['Enums']['ticket_state'];
          stepped_out_at?: string | null;
          ticket_number?: string;
          updated_at?: string;
          version?: number;
        };
        Relationships: [
          {
            foreignKeyName: 'queue_tickets_appointment_id_fkey';
            columns: ['appointment_id'];
            isOneToOne: false;
            referencedRelation: 'appointments';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'queue_tickets_assigned_barber_id_fkey';
            columns: ['assigned_barber_id'];
            isOneToOne: false;
            referencedRelation: 'barbers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'queue_tickets_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'queue_tickets_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'queue_tickets_branch_service_id_fkey';
            columns: ['branch_service_id'];
            isOneToOne: false;
            referencedRelation: 'branch_services';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'queue_tickets_created_by_staff_id_fkey';
            columns: ['created_by_staff_id'];
            isOneToOne: false;
            referencedRelation: 'staff_users';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'queue_tickets_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customer_segments';
            referencedColumns: ['customer_id'];
          },
          {
            foreignKeyName: 'queue_tickets_customer_id_fkey';
            columns: ['customer_id'];
            isOneToOne: false;
            referencedRelation: 'customers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'queue_tickets_preferred_barber_id_fkey';
            columns: ['preferred_barber_id'];
            isOneToOne: false;
            referencedRelation: 'barbers';
            referencedColumns: ['id'];
          },
        ];
      };
      role_capabilities: {
        Row: {
          capability: string;
          role: Database['public']['Enums']['staff_role'];
        };
        Insert: {
          capability: string;
          role: Database['public']['Enums']['staff_role'];
        };
        Update: {
          capability?: string;
          role?: Database['public']['Enums']['staff_role'];
        };
        Relationships: [
          {
            foreignKeyName: 'role_capabilities_capability_fkey';
            columns: ['capability'];
            isOneToOne: false;
            referencedRelation: 'capabilities';
            referencedColumns: ['key'];
          },
        ];
      };
      service_sessions: {
        Row: {
          actual_duration_seconds: number | null;
          barber_id: string;
          created_at: string;
          ended_at: string | null;
          id: string;
          started_at: string;
          ticket_id: string;
        };
        Insert: {
          actual_duration_seconds?: number | null;
          barber_id: string;
          created_at?: string;
          ended_at?: string | null;
          id?: string;
          started_at: string;
          ticket_id: string;
        };
        Update: {
          actual_duration_seconds?: number | null;
          barber_id?: string;
          created_at?: string;
          ended_at?: string | null;
          id?: string;
          started_at?: string;
          ticket_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'service_sessions_barber_id_fkey';
            columns: ['barber_id'];
            isOneToOne: false;
            referencedRelation: 'barbers';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'service_sessions_ticket_id_fkey';
            columns: ['ticket_id'];
            isOneToOne: true;
            referencedRelation: 'queue_tickets';
            referencedColumns: ['id'];
          },
        ];
      };
      services: {
        Row: {
          business_id: string;
          category: string | null;
          created_at: string;
          default_duration_minutes: number;
          description: string | null;
          id: string;
          image_url: string | null;
          is_active: boolean;
          name: string;
          updated_at: string;
        };
        Insert: {
          business_id: string;
          category?: string | null;
          created_at?: string;
          default_duration_minutes: number;
          description?: string | null;
          id?: string;
          image_url?: string | null;
          is_active?: boolean;
          name: string;
          updated_at?: string;
        };
        Update: {
          business_id?: string;
          category?: string | null;
          created_at?: string;
          default_duration_minutes?: number;
          description?: string | null;
          id?: string;
          image_url?: string | null;
          is_active?: boolean;
          name?: string;
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'services_business_id_fkey';
            columns: ['business_id'];
            isOneToOne: false;
            referencedRelation: 'businesses';
            referencedColumns: ['id'];
          },
        ];
      };
      staff_branch_assignments: {
        Row: {
          branch_id: string;
          staff_user_id: string;
        };
        Insert: {
          branch_id: string;
          staff_user_id: string;
        };
        Update: {
          branch_id?: string;
          staff_user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'staff_branch_assignments_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branch_status_view';
            referencedColumns: ['branch_id'];
          },
          {
            foreignKeyName: 'staff_branch_assignments_branch_id_fkey';
            columns: ['branch_id'];
            isOneToOne: false;
            referencedRelation: 'branches';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'staff_branch_assignments_staff_user_id_fkey';
            columns: ['staff_user_id'];
            isOneToOne: false;
            referencedRelation: 'staff_users';
            referencedColumns: ['id'];
          },
        ];
      };
      staff_users: {
        Row: {
          auth_user_id: string;
          created_at: string;
          email: string | null;
          id: string;
          invite_accepted_at: string | null;
          invite_expires_at: string | null;
          invite_status: Database['public']['Enums']['staff_invite_status'];
          invite_token_hash: string | null;
          invited_at: string | null;
          invited_by_staff_id: string | null;
          is_active: boolean;
          name: string;
          phone_e164: string | null;
          pin_hash: string | null;
          role: Database['public']['Enums']['staff_role'];
          updated_at: string;
        };
        Insert: {
          auth_user_id: string;
          created_at?: string;
          email?: string | null;
          id?: string;
          invite_accepted_at?: string | null;
          invite_expires_at?: string | null;
          invite_status?: Database['public']['Enums']['staff_invite_status'];
          invite_token_hash?: string | null;
          invited_at?: string | null;
          invited_by_staff_id?: string | null;
          is_active?: boolean;
          name: string;
          phone_e164?: string | null;
          pin_hash?: string | null;
          role: Database['public']['Enums']['staff_role'];
          updated_at?: string;
        };
        Update: {
          auth_user_id?: string;
          created_at?: string;
          email?: string | null;
          id?: string;
          invite_accepted_at?: string | null;
          invite_expires_at?: string | null;
          invite_status?: Database['public']['Enums']['staff_invite_status'];
          invite_token_hash?: string | null;
          invited_at?: string | null;
          invited_by_staff_id?: string | null;
          is_active?: boolean;
          name?: string;
          phone_e164?: string | null;
          pin_hash?: string | null;
          role?: Database['public']['Enums']['staff_role'];
          updated_at?: string;
        };
        Relationships: [
          {
            foreignKeyName: 'staff_users_invited_by_staff_id_fkey';
            columns: ['invited_by_staff_id'];
            isOneToOne: false;
            referencedRelation: 'staff_users';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: {
      branch_status_view: {
        Row: {
          branch_id: string | null;
          status: Database['public']['Enums']['branch_status'] | null;
        };
        Relationships: [];
      };
      current_branch_service_price: {
        Row: {
          branch_service_id: string | null;
          is_promo: boolean | null;
          price_ghs: number | null;
        };
        Relationships: [
          {
            foreignKeyName: 'branch_service_prices_branch_service_id_fkey';
            columns: ['branch_service_id'];
            isOneToOne: false;
            referencedRelation: 'branch_services';
            referencedColumns: ['id'];
          },
        ];
      };
      customer_segments: {
        Row: {
          completed_visits: number | null;
          customer_id: string | null;
          last_visit_at: string | null;
          segment: string | null;
        };
        Relationships: [];
      };
    };
    Functions: {
      activate_due_appointments: { Args: never; Returns: number };
      appointments_minute_tick: { Args: never; Returns: undefined };
      auth_branch_ids: { Args: never; Returns: string[] };
      auth_role: { Args: never; Returns: string };
      auth_staff_id: { Args: never; Returns: string };
      book_appointment: {
        Args: { p_branch_service_id: string; p_barber_id: string | null; p_slot_start: string };
        Returns: string;
      };
      branch_feedback_summary: {
        Args: { p_branch_id: string };
        Returns: { average_rating: number | null; rating_count: number }[];
      };
      branch_report: {
        Args: { p_branch_ids: string[]; p_from: string; p_to: string };
        Returns: Json;
      };
      branch_today: { Args: { p_branch_id: string }; Returns: Json };
      cancel_appointment: {
        Args: {
          p_appointment_id: string;
          p_reason: Database['public']['Enums']['cancel_reason'];
        };
        Returns: undefined;
      };
      claim_sms_notifications: {
        Args: { p_types: string[]; p_limit: number };
        Returns: {
          notification_id: string;
          notification_type: string;
          created_at: string;
          dispatch_attempts: number;
          customer_id: string;
          phone_e164: string | null;
          sms_backup_enabled: boolean | null;
          ticket_id: string | null;
          ticket_state: Database['public']['Enums']['ticket_state'] | null;
          ticket_number: string | null;
          branch_name: string | null;
          appointment_id: string | null;
          appointment_status: Database['public']['Enums']['appointment_status'] | null;
          appointment_slot: string | null;
          payload_slot: string | null;
          push_enabled: boolean | null;
          push_subscriptions: Json;
          ticket_has_feedback: boolean | null;
        }[];
      };
      custom_access_token_hook: { Args: { event: Json }; Returns: Json };
      customer_detail: {
        Args: { p_customer_id: string; p_branch_ids: string[] };
        Returns: Json;
      };
      enqueue_appointment_reminders: { Args: { p_now?: string }; Returns: number };
      fill_barber_schedule: {
        Args: { p_barber_id?: string | null };
        Returns: undefined;
      };
      find_eligible_barber: {
        Args: {
          p_branch_id: string;
          p_branch_service_id: string;
          p_preferred_barber_id: string | null;
        };
        Returns: {
          preferred_eligible: boolean;
          preferred_scheduled_today: boolean;
          fallback_barber_id: string | null;
        }[];
      };
      has_capability: { Args: { cap: string }; Returns: boolean };
      in_branch_scope: { Args: { target_branch: string }; Returns: boolean };
      link_or_create_customer: {
        Args: { p_name: string };
        Returns: {
          anonymized_at: string | null;
          auth_user_id: string | null;
          avatar_key: string | null;
          created_at: string;
          email: string | null;
          id: string;
          is_anonymized: boolean;
          last_activity_at: string;
          late_cancellation_count: number;
          name: string;
          no_show_count: number;
          phone_e164: string | null;
          preferred_branch_id: string | null;
          push_enabled: boolean;
          push_lead_minutes_primary: number;
          push_lead_minutes_secondary: number;
          requires_confirmation_call: boolean;
          sms_backup_enabled: boolean;
          updated_at: string;
        };
        SetofOptions: {
          from: '*';
          to: 'customers';
          isOneToOne: true;
          isSetofReturn: false;
        };
      };
      get_branch_appointment: {
        Args: { p_appointment_id: string };
        Returns: {
          id: string;
          branch_id: string;
          branch_name: string;
          branch_service_id: string;
          service_name: string;
          price_ghs: number | null;
          scheduled_start: string;
          scheduled_end: string;
          status: Database['public']['Enums']['appointment_status'];
          customer_id: string;
          customer_name: string;
          customer_phone: string | null;
          preferred_barber_id: string | null;
          barber_name: string | null;
          created_by: Database['public']['Enums']['ticket_created_by'];
          created_by_staff_name: string | null;
          checked_in_at: string | null;
          ticket_id: string | null;
        }[];
      };
      list_appointment_slots: {
        Args: {
          p_branch_service_id: string;
          p_barber_id: string | null;
          p_date: string;
          p_ignore_appointment_id?: string | null;
        };
        Returns: string[];
      };
      list_bookable_barbers: {
        Args: { p_branch_id: string };
        Returns: {
          id: string;
          staff_user_id: string;
          home_branch_id: string;
          status: Database['public']['Enums']['barber_status'];
          display_name: string;
        }[];
      };
      list_branch_appointments: {
        Args: { p_branch_id: string; p_date: string };
        Returns: Database['public']['Functions']['get_branch_appointment']['Returns'];
      };
      list_branch_feedback: {
        Args: { p_branch_id: string };
        Returns: {
          id: string;
          created_at: string;
          customer_first_name: string;
          barber_name: string;
          service_name: string;
          overall_rating: number;
          service_quality_rating: number | null;
          barber_professionalism_rating: number | null;
          waiting_experience_rating: number | null;
          cleanliness_rating: number | null;
          value_rating: number | null;
          comment: string | null;
          seen_at: string | null;
          seen_by_name: string | null;
        }[];
      };
      list_customers: {
        Args: {
          p_branch_ids: string[];
          p_search: string | null;
          p_group: string | null;
          p_offset?: number;
        };
        Returns: Json;
      };
      list_manageable_barbers: {
        Args: never;
        Returns: {
          barber_id: string;
          staff_user_id: string;
          name: string;
          status: Database['public']['Enums']['barber_status'];
          home_branch_id: string;
          home_branch_name: string;
        }[];
      };
      list_my_appointments_today: {
        Args: never;
        Returns: {
          id: string;
          scheduled_start: string;
          customer_first_name: string;
          status: Database['public']['Enums']['appointment_status'];
        }[];
      };
      list_my_feedback: {
        Args: never;
        Returns: {
          id: string;
          ticket_id: string;
          created_at: string;
          branch_name: string;
          barber_name: string;
          overall_rating: number;
          comment: string | null;
        }[];
      };
      list_staff_accounts: {
        Args: never;
        Returns: {
          staff_user_id: string;
          name: string;
          role: Database['public']['Enums']['staff_role'];
          email: string | null;
          phone_e164: string | null;
          branch_id: string | null;
          branch_name: string | null;
          status: string;
          invited_at: string | null;
          is_self: boolean;
        }[];
      };
      list_unseen_low_feedback_count: { Args: never; Returns: number };
      mark_feedback_seen: { Args: { p_feedback_id: string }; Returns: undefined };
      next_ticket_number: { Args: { p_branch_id: string }; Returns: string };
      preview_wait_estimate: {
        Args: { p_branch_service_id: string; p_barber_id: string | null };
        Returns: { low_min: number; high_min: number }[];
      };
      recalculate_positions: {
        Args: { p_barber_id: string; p_branch_id: string };
        Returns: undefined;
      };
      refresh_all_wait_estimates: { Args: never; Returns: undefined };
      refresh_wait_estimates: {
        Args: { p_branch_id: string; p_barber_id: string };
        Returns: undefined;
      };
      remove_push_subscription: { Args: { p_endpoint: string }; Returns: undefined };
      reschedule_appointment: {
        Args: { p_appointment_id: string; p_slot_start: string };
        Returns: undefined;
      };
      reset_barber_schedule_day: {
        Args: { p_barber_id: string; p_date: string };
        Returns: undefined;
      };
      save_push_subscription: {
        Args: { p_endpoint: string; p_p256dh: string; p_auth: string; p_user_agent: string };
        Returns: undefined;
      };
      send_customer_message: {
        Args: { p_customer_id: string; p_branch_id: string; p_text: string };
        Returns: string;
      };
      set_long_wait_warning: {
        Args: { p_branch_id: string; p_minutes: number };
        Returns: undefined;
      };
      set_barber_weekly_hours: {
        Args: { p_barber_id: string; p_days: Json };
        Returns: undefined;
      };
      submit_feedback: {
        Args: {
          p_ticket_id: string;
          p_overall: number;
          p_service_quality?: number | null;
          p_barber_professionalism?: number | null;
          p_waiting_experience?: number | null;
          p_cleanliness?: number | null;
          p_value?: number | null;
          p_comment?: string | null;
        };
        Returns: string;
      };
      staff_book_appointment: {
        Args: {
          p_branch_service_id: string;
          p_barber_id: string | null;
          p_slot_start: string;
          p_customer_name: string;
          p_customer_phone: string | null;
        };
        Returns: string;
      };
      staff_cancel_appointment: {
        Args: {
          p_appointment_id: string;
          p_reason: Database['public']['Enums']['cancel_reason'];
        };
        Returns: undefined;
      };
      check_in_my_appointment: { Args: { p_appointment_id: string }; Returns: string | null };
      staff_check_in_appointment: { Args: { p_appointment_id: string }; Returns: string | null };
      staff_mark_appointment_no_show: { Args: { p_appointment_id: string }; Returns: undefined };
      staff_reschedule_appointment: {
        Args: { p_appointment_id: string; p_slot_start: string };
        Returns: undefined;
      };
      staff_list_appointment_slots: {
        Args: {
          p_branch_service_id: string;
          p_barber_id: string | null;
          p_date: string;
          p_customer_id?: string | null;
          p_ignore_appointment_id?: string | null;
        };
        Returns: string[];
      };
    };
    Enums: {
      appointment_status:
        'scheduled' | 'checked_in' | 'converted' | 'completed' | 'cancelled' | 'no_show';
      barber_status:
        | 'offline'
        | 'scheduled'
        | 'available'
        | 'busy'
        | 'on_break'
        | 'temporarily_unavailable'
        | 'end_of_shift';
      branch_status: 'open' | 'closed' | 'closing_soon' | 'temporarily_closed';
      cancel_reason:
        | 'wait_too_long'
        | 'cant_make_it'
        | 'changed_plans'
        | 'found_another_barber'
        | 'emergency'
        | 'other'
        | 'branch_closed';
      check_in_method: 'app_tap' | 'qr_code' | 'staff' | 'geofence';
      consent_type: 'transactional' | 'marketing';
      notification_channel: 'sms' | 'push';
      notification_recipient_type: 'customer' | 'staff';
      notification_status: 'pending' | 'sent' | 'delivered' | 'failed' | 'fallback_sent';
      staff_invite_status: 'pending' | 'accepted' | 'revoked' | 'expired';
      staff_role: 'owner' | 'branch_manager' | 'receptionist' | 'barber' | 'analyst';
      ticket_created_by: 'customer' | 'staff' | 'appointment_conversion';
      ticket_state:
        | 'created'
        | 'waiting'
        | 'almost_turn'
        | 'called'
        | 'confirmed'
        | 'grace_period'
        | 'in_service'
        | 'completed'
        | 'no_show'
        | 'cancelled';
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, 'public'>];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Views'])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema['Tables'] & DefaultSchema['Views'])
    ? (DefaultSchema['Tables'] & DefaultSchema['Views'])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema['Tables'] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables']
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions['schema']]['Tables'][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema['Tables']
    ? DefaultSchema['Tables'][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema['Enums'] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums']
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions['schema']]['Enums'][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema['Enums']
    ? DefaultSchema['Enums'][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema['CompositeTypes'] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes']
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions['schema']]['CompositeTypes'][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema['CompositeTypes']
    ? DefaultSchema['CompositeTypes'][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      appointment_status: [
        'scheduled',
        'checked_in',
        'converted',
        'completed',
        'cancelled',
        'no_show',
      ],
      barber_status: [
        'offline',
        'scheduled',
        'available',
        'busy',
        'on_break',
        'temporarily_unavailable',
        'end_of_shift',
      ],
      branch_status: ['open', 'closed', 'closing_soon', 'temporarily_closed'],
      cancel_reason: [
        'wait_too_long',
        'cant_make_it',
        'changed_plans',
        'found_another_barber',
        'emergency',
        'other',
        'branch_closed',
      ],
      check_in_method: ['app_tap', 'qr_code', 'staff', 'geofence'],
      consent_type: ['transactional', 'marketing'],
      notification_channel: ['sms', 'push'],
      notification_recipient_type: ['customer', 'staff'],
      notification_status: ['pending', 'sent', 'delivered', 'failed', 'fallback_sent'],
      staff_invite_status: ['pending', 'accepted', 'revoked', 'expired'],
      staff_role: ['owner', 'branch_manager', 'receptionist', 'barber', 'analyst'],
      ticket_created_by: ['customer', 'staff', 'appointment_conversion'],
      ticket_state: [
        'created',
        'waiting',
        'almost_turn',
        'called',
        'confirmed',
        'grace_period',
        'in_service',
        'completed',
        'no_show',
        'cancelled',
      ],
    },
  },
} as const;
