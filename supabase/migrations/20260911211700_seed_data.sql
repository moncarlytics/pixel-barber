-- Implementation plan Phase 1 scope: "Seed one businesses row, two or three branches rows with
-- hours, a handful of services/branch_services/branch_service_prices" -- seeded here with the
-- real business data gathered up front (one branch is real; address is TBD per instruction,
-- seeded with a placeholder Accra-area coordinate until a real address is decided). Service
-- durations are placeholder estimates (not specified by the business) -- adjustable through the
-- Settings -> Services & Pricing screen Phase 2 builds; they don't affect anything Phase 1
-- verifies (auth, RLS, the walking skeleton).

do $$
declare
  v_business_id uuid;
  v_branch_id   uuid;
  v_day         smallint;
begin
  insert into businesses (name, default_currency)
    values ('Pixel Barber', 'GHS')
    returning id into v_business_id;

  insert into branches (
    business_id, name, branch_code, address, latitude, longitude
  ) values (
    v_business_id, 'Pixel Barber', 'ACC', 'TBD', 5.603717, -0.186964
  ) returning id into v_branch_id;

  -- Monday-Saturday 9am-9pm, closed Sunday.
  for v_day in 0..6 loop
    if v_day = 0 then
      insert into branch_hours (branch_id, day_of_week, is_closed)
        values (v_branch_id, v_day, true);
    else
      insert into branch_hours (branch_id, day_of_week, opens_at, closes_at, is_closed)
        values (v_branch_id, v_day, '09:00', '21:00', false);
    end if;
  end loop;

  -- Full service list with GHS prices, as given for the business.
  with svc(name, price_ghs, duration_minutes) as (
    values
      ('Regular Cut',                          70.00,  30),
      ('Regular Cut With Hair Fiber',           80.00,  40),
      ('Regular Cut & Black Dye',              100.00,  60),
      ('Regular Cut & Gold Dye',                120.00,  70),
      ('Regular Cut & Other Color',             150.00,  75),
      ('Perm Cut',                              100.00,  60),
      ('Perm Cut & Black Dye',                  120.00,  75),
      ('Perm Cut & Other Dye',                  150.00,  80),
      ('Waves Cut',                             100.00,  60),
      ('Waves Cut & Black Dye',                 120.00,  75),
      ('Waves Cut & Gold Dye',                  150.00,  85),
      ('Finger Twist & Cut',                    200.00, 120),
      ('Finger Twist, Black Dye & Cut',         220.00, 135),
      ('Finger Twist, Other Dye & Cut',         250.00, 150),
      ('Caucasion',                             150.00,  45)
  ),
  inserted_services as (
    insert into services (business_id, name, default_duration_minutes)
    select v_business_id, svc.name, svc.duration_minutes from svc
    returning id, name
  ),
  inserted_branch_services as (
    insert into branch_services (branch_id, service_id)
    select v_branch_id, inserted_services.id from inserted_services
    returning id, service_id
  )
  insert into branch_service_prices (branch_service_id, price_ghs, effective_from)
  select ibs.id, svc.price_ghs, current_date
  from inserted_branch_services ibs
  join inserted_services isv on isv.id = ibs.service_id
  join svc on svc.name = isv.name;
end $$;
