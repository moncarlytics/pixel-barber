-- Backend schema doc section 15.3. Shown here as the illustrative state-transition-only version
-- the doc itself describes; Phase 5 (grace-period escalation) and Phase 6 (appointment
-- activation) extend these into named functions that also write queue_events and enqueue
-- notifications, per that section's own note.
select cron.schedule(
  'expire-no-show-grace-periods',
  '30 seconds',
  $$
  update queue_tickets
    set state = 'no_show', no_show_at = now()
    where state in ('called','grace_period')
      and grace_period_expires_at < now();
  $$
);

select cron.schedule(
  'activate-due-appointments',
  '* * * * *',
  $$
  with due as (
    select a.* from appointments a
    where a.status = 'scheduled' and a.scheduled_start <= now() + interval '5 minutes'
  ),
  created as (
    insert into queue_tickets (
      ticket_number, branch_id, customer_id, branch_service_id, preferred_barber_id,
      appointment_id, state, created_by
    )
    select
      next_ticket_number(due.branch_id), due.branch_id, due.customer_id, due.branch_service_id,
      due.preferred_barber_id, due.id, 'waiting', 'appointment_conversion'
    from due
    returning appointment_id
  )
  update appointments set status = 'converted'
    where id in (select appointment_id from created);
  $$
);
