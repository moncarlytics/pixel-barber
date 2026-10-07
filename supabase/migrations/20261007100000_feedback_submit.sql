-- After-visit feedback, customer side (Docs/superpowers/specs/2026-10-07-after-visit-feedback-design.md):
-- customers submit through submit_feedback only, list their own with list_my_feedback, and completing
-- a ticket queues one 'feedback_request' notification for app customers.

-- Direct inserts would bypass the 7-day window, validation and derived branch/barber.
drop policy if exists feedback_customer_submit on feedback;

create or replace function submit_feedback(
  p_ticket_id uuid,
  p_overall smallint,
  p_service_quality smallint default null,
  p_barber_professionalism smallint default null,
  p_waiting_experience smallint default null,
  p_cleanliness smallint default null,
  p_value smallint default null,
  p_comment text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_customer_id uuid := current_customer_id();
  v_ticket queue_tickets%rowtype;
  v_comment text;
  v_id uuid;
begin
  select * into v_ticket from queue_tickets
  where id = p_ticket_id and customer_id = v_customer_id;
  if v_customer_id is null or not found then
    raise exception 'not_found';
  end if;
  if v_ticket.state <> 'completed' or v_ticket.assigned_barber_id is null then
    raise exception 'not_completed';
  end if;
  if coalesce(v_ticket.completed_at, v_ticket.updated_at) < now() - interval '7 days' then
    raise exception 'too_late';
  end if;
  if exists (select 1 from feedback where ticket_id = p_ticket_id) then
    raise exception 'already_submitted';
  end if;
  if p_overall is null or p_overall not between 1 and 5
     or (p_service_quality is not null and p_service_quality not between 1 and 5)
     or (p_barber_professionalism is not null and p_barber_professionalism not between 1 and 5)
     or (p_waiting_experience is not null and p_waiting_experience not between 1 and 5)
     or (p_cleanliness is not null and p_cleanliness not between 1 and 5)
     or (p_value is not null and p_value not between 1 and 5) then
    raise exception 'invalid_rating';
  end if;
  v_comment := nullif(btrim(coalesce(p_comment, '')), '');
  if v_comment is not null and char_length(v_comment) > 1000 then
    raise exception 'invalid_comment';
  end if;

  begin
    insert into feedback (
      ticket_id, customer_id, branch_id, barber_id, overall_rating, service_quality_rating,
      barber_professionalism_rating, waiting_experience_rating, cleanliness_rating, value_rating,
      comment
    ) values (
      p_ticket_id, v_customer_id, v_ticket.branch_id, v_ticket.assigned_barber_id, p_overall,
      p_service_quality, p_barber_professionalism, p_waiting_experience, p_cleanliness, p_value,
      v_comment
    )
    returning id into v_id;
  exception when unique_violation then
    -- Two submits racing: the second loses on feedback.ticket_id's unique constraint.
    raise exception 'already_submitted';
  end;
  return v_id;
end;
$$;

revoke execute on function submit_feedback(uuid, smallint, smallint, smallint, smallint, smallint, smallint, text) from public, anon;
grant execute on function submit_feedback(uuid, smallint, smallint, smallint, smallint, smallint, smallint, text) to authenticated;

-- The caller's own feedback for Profile, with names customers can't read directly.
create or replace function list_my_feedback()
returns table (
  id uuid,
  ticket_id uuid,
  created_at timestamptz,
  branch_name text,
  barber_name text,
  overall_rating smallint,
  comment text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select f.id, f.ticket_id, f.created_at, b.name, su.name, f.overall_rating, f.comment
  from feedback f
  join branches b on b.id = f.branch_id
  join barbers br on br.id = f.barber_id
  join staff_users su on su.id = br.staff_user_id
  where f.customer_id = current_customer_id()
  order by f.created_at desc;
$$;

revoke execute on function list_my_feedback() from public, anon;
grant execute on function list_my_feedback() to authenticated;

-- One feedback request per ticket.
create unique index if not exists notifications_one_feedback_request_per_ticket
  on notifications (related_ticket_id) where notification_type = 'feedback_request';

-- Completing a ticket queues the request (app customers only). Never blocks the completion.
create or replace function trg_queue_feedback_request() returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.state = 'completed' and old.state is distinct from 'completed'
     and exists (select 1 from customers c where c.id = new.customer_id and c.auth_user_id is not null) then
    begin
      insert into notifications (recipient_type, recipient_id, channel, notification_type, related_ticket_id, payload)
      values ('customer', new.customer_id, 'sms', 'feedback_request', new.id, '{}'::jsonb)
      on conflict (related_ticket_id) where notification_type = 'feedback_request' do nothing;
    exception when others then
      raise warning 'feedback request for ticket % not queued: %', new.id, sqlerrm;
    end;
  end if;
  return new;
end;
$$;

revoke execute on function trg_queue_feedback_request() from public, anon, authenticated;

drop trigger if exists after_ticket_completed_feedback_request on queue_tickets;
create trigger after_ticket_completed_feedback_request
  after update of state on queue_tickets
  for each row execute function trg_queue_feedback_request();
