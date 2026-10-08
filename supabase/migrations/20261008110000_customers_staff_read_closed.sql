-- Staff no longer read the customers table directly (Docs/superpowers/specs/2026-10-08-customer-list-design.md,
-- "staff read only through the functions"). customers_staff_scoped let any staff JWT -- barbers and
-- analysts included -- select phone_e164 and email for every customer with a ticket at their
-- branches (owner: all), which bypassed the customer list's phone masking. No staff screen reads
-- customers directly: they use security definer functions (list_customers, customer_detail, the
-- queue and appointment functions), and Edge Functions use the service role. Customers keep
-- customers_self_read; staff keep customers_staff_register_walkin (insert only).
drop policy if exists customers_staff_scoped on customers;
