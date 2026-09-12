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
      barber_schedule: {
        Row: {
          barber_id: string;
          branch_id: string;
          break_end: string | null;
          break_start: string | null;
          id: string;
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
          invite_status: Database['public']['Enums']['staff_invite_status'];
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
          invite_status?: Database['public']['Enums']['staff_invite_status'];
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
          invite_status?: Database['public']['Enums']['staff_invite_status'];
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
      auth_branch_ids: { Args: never; Returns: string[] };
      auth_role: { Args: never; Returns: string };
      auth_staff_id: { Args: never; Returns: string };
      custom_access_token_hook: { Args: { event: Json }; Returns: Json };
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
      next_ticket_number: { Args: { p_branch_id: string }; Returns: string };
      recalculate_positions: {
        Args: { p_barber_id: string; p_branch_id: string };
        Returns: undefined;
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
        | 'other';
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
