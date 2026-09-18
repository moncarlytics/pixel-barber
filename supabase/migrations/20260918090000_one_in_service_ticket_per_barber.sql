-- Final Phase 5 review finding: nothing stopped a barber from Acknowledging a second ticket
-- while one was already in_service, which errored refetchQueue's .maybeSingle() current-ticket
-- read and permanently bricked Today's Queue (no error, no Mark Complete, for either ticket).
-- This constraint makes the second Acknowledge attempt fail cleanly at the database instead --
-- updateTicketWithVersion already turns a Postgres error into a typed
-- {success:false, reason:'rejected', error} result the UI already handles.
create unique index one_in_service_ticket_per_barber on queue_tickets (assigned_barber_id)
  where state = 'in_service';
