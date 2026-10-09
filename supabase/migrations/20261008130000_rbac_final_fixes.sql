-- Final fixes from the role/permission check.

-- C1: customers must not insert queue tickets directly. A direct insert lets a customer choose
-- created_at (queue-jump), ticket_number (squat numbers so tickets-join fails), appointment_id,
-- created_by_staff_id, position and so on. Customers join only through the tickets-join Edge
-- Function (service role), as appointments_customer_create was already dropped for the booking
-- functions in 20261001090100_appointment_booking.sql.
drop policy if exists tickets_customer_create on queue_tickets;

-- G-ticket-customer-cancel-state: a customer may cancel their own ticket only while it is still
-- live. Without a limit on the OLD state they could flip a completed or no_show ticket to cancelled
-- and write completed_at / service_started_at. The customer app sends state, cancel_reason and
-- cancelled_at only (apps/customer/app/tickets/[id]/page.tsx).
alter policy tickets_customer_cancel on queue_tickets
  using (customer_id = current_customer_id()
         and state in ('created','waiting','almost_turn','called','confirmed','grace_period'))
  with check (customer_id = current_customer_id()
              and state = 'cancelled'
              and completed_at is null and no_show_at is null and service_started_at is null);
