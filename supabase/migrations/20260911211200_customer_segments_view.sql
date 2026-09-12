-- Backend schema doc section 13.
create view customer_segments as
select
  c.id as customer_id,
  count(qt.id) filter (where qt.state = 'completed') as completed_visits,
  max(qt.completed_at) as last_visit_at,
  case
    when count(qt.id) filter (where qt.state = 'completed') = 0 then 'new'
    when max(qt.completed_at) < now() - interval '90 days' then 'dormant'
    when c.no_show_count >= 3 or c.late_cancellation_count >= 3 then 'at_risk'
    when count(qt.id) filter (where qt.state = 'completed' and qt.completed_at > now() - interval '90 days') >= 3 then 'frequent'
    else 'returning'
  end as segment
from customers c
left join queue_tickets qt on qt.customer_id = c.id
where c.is_anonymized = false
group by c.id;
