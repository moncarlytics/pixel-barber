-- Appointments part 1: an appointment whose branch is closed at its start time is cancelled with
-- this reason by activate_due_appointments (20261001090300). Its own migration: a new enum value
-- can't be used inside the transaction that adds it.
alter type cancel_reason add value if not exists 'branch_closed';
