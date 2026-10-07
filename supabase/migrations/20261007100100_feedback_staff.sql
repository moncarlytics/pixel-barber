-- After-visit feedback, staff side (Docs/superpowers/specs/2026-10-07-after-visit-feedback-design.md):
-- low ratings (1-2 stars) alert owners/branch managers until marked seen; a branch list and 30-day
-- summary for staff who can view branch reports.

alter table feedback
  add column if not exists seen_at timestamptz,
  add column if not exists seen_by_staff_id uuid references staff_users(id);

create index if not exists idx_feedback_branch_created on feedback (branch_id, created_at desc);

create or replace function list_unseen_low_feedback_count()
returns integer
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when has_capability('handle_escalations') then
    (select count(*)::int from feedback f
     where f.overall_rating <= 2 and f.seen_at is null and in_branch_scope(f.branch_id))
  else 0 end;
$$;

revoke execute on function list_unseen_low_feedback_count() from public, anon;
grant execute on function list_unseen_low_feedback_count() to authenticated;

create or replace function mark_feedback_seen(p_feedback_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_branch uuid;
begin
  select branch_id into v_branch from feedback where id = p_feedback_id;
  if v_branch is null then
    raise exception 'not_found';
  end if;
  if not (has_capability('handle_escalations') and in_branch_scope(v_branch)) then
    raise exception 'not_allowed';
  end if;
  -- First viewer wins: an already-seen rating keeps its original values.
  update feedback
    set seen_at = now(), seen_by_staff_id = auth_staff_id()
    where id = p_feedback_id and seen_at is null;
end;
$$;

revoke execute on function mark_feedback_seen(uuid) from public, anon;
grant execute on function mark_feedback_seen(uuid) to authenticated;

create or replace function list_branch_feedback(p_branch_id uuid)
returns table (
  id uuid,
  created_at timestamptz,
  customer_first_name text,
  barber_name text,
  service_name text,
  overall_rating smallint,
  service_quality_rating smallint,
  barber_professionalism_rating smallint,
  waiting_experience_rating smallint,
  cleanliness_rating smallint,
  value_rating smallint,
  comment text,
  seen_at timestamptz,
  seen_by_name text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (has_capability('view_branch_reports') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  return query
    select f.id, f.created_at, split_part(trim(c.name), ' ', 1), su.name, s.name,
           f.overall_rating, f.service_quality_rating, f.barber_professionalism_rating,
           f.waiting_experience_rating, f.cleanliness_rating, f.value_rating, f.comment,
           f.seen_at, seen.name
    from feedback f
    join customers c on c.id = f.customer_id
    join barbers br on br.id = f.barber_id
    join staff_users su on su.id = br.staff_user_id
    join queue_tickets t on t.id = f.ticket_id
    join branch_services bs on bs.id = t.branch_service_id
    join services s on s.id = bs.service_id
    left join staff_users seen on seen.id = f.seen_by_staff_id
    where f.branch_id = p_branch_id
    order by f.created_at desc
    limit 100;
end;
$$;

revoke execute on function list_branch_feedback(uuid) from public, anon;
grant execute on function list_branch_feedback(uuid) to authenticated;

create or replace function branch_feedback_summary(p_branch_id uuid)
returns table (average_rating numeric, rating_count integer)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not (has_capability('view_branch_reports') and in_branch_scope(p_branch_id)) then
    raise exception 'not_allowed';
  end if;
  return query
    select round(avg(f.overall_rating)::numeric, 2), count(*)::int
    from feedback f
    where f.branch_id = p_branch_id and f.created_at > now() - interval '30 days';
end;
$$;

revoke execute on function branch_feedback_summary(uuid) from public, anon;
grant execute on function branch_feedback_summary(uuid) to authenticated;
