-- Backend schema doc section 16. queue_events and audit_log are deliberately excluded — they're
-- read on demand, not watched live.
alter publication supabase_realtime add table
  queue_tickets, appointments, barbers, notifications, branches;
