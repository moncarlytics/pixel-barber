// tests/db/fixtures/appointments.ts
// Shared fixture for the appointment tests: one branch open 00:00-23:59:59 every day, a 30-minute
// service offered there, two barbers (A, B) skilled for it and scheduled at the branch all day for
// today + the next 15 days (A has a 12:00-13:00 break every day), a second branch (for
// branch-closure cases), four phone customers and one barber login, each with a signed-in client.
// Not a test file itself (vitest only collects *.test.ts).
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

export type Client = SupabaseClient<Database>;
export const PASSWORD = 'Test-Password-123!';
const DAY = 24 * 60 * 60 * 1000;

export interface AppointmentFixture {
  admin: Client;
  suffix: string;
  serviceId: string;
  branchId: string;
  branchServiceId: string;
  closedBranchId: string;
  closedBranchServiceId: string;
  barberA: { barberId: string; staffUserId: string; authUserId: string };
  barberB: { barberId: string; staffUserId: string; authUserId: string };
  barberClient: Client;
  customers: { customerId: string; authUserId: string; phone: string; client: Client }[];
}

function env() {
  return {
    url: process.env.NEXT_PUBLIC_SUPABASE_URL!,
    anonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  };
}

/** UTC calendar date `dayOffset` days from today, as YYYY-MM-DD. */
export function dateAt(dayOffset: number): string {
  return new Date(Date.now() + dayOffset * DAY).toISOString().slice(0, 10);
}

/** ISO timestamp for HH:MM UTC on the day `dayOffset` days from today. */
export function slotAt(dayOffset: number, hhmm: string): string {
  return new Date(`${dateAt(dayOffset)}T${hhmm}:00.000Z`).toISOString();
}

async function signIn(creds: { email: string } | { phone: string }): Promise<Client> {
  const { url, anonKey } = env();
  const client = createClient<Database>(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { error } = await client.auth.signInWithPassword({ ...creds, password: PASSWORD });
  if (error) throw error;
  return client;
}

async function createBranch(admin: Client, businessId: string, label: string, suffix: string) {
  const { data, error } = await admin
    .from('branches')
    .insert({
      business_id: businessId,
      name: `Appt ${label} ${suffix}`,
      branch_code: `AP${label[0]}${suffix.slice(-5)}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select('id')
    .single();
  if (error) throw error;
  const { error: hoursError } = await admin.from('branch_hours').insert(
    [0, 1, 2, 3, 4, 5, 6].map((day_of_week) => ({
      branch_id: data.id,
      day_of_week,
      opens_at: '00:00:00',
      closes_at: '23:59:59',
      is_closed: false,
    })),
  );
  if (hoursError) throw hoursError;
  return data.id as string;
}

async function createBarber(
  admin: Client,
  label: string,
  suffix: string,
  branchId: string,
  serviceId: string,
  withBreak: boolean,
) {
  const email = `appt-barber-${label}-${suffix}@test.pixelbarber.local`;
  const { data: auth, error: authError } = await admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError) throw authError;
  const { data: staff, error: staffError } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: auth.user.id,
      name: `Appt Barber ${label}`,
      email,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select('id')
    .single();
  if (staffError) throw staffError;
  const { data: barber, error: barberError } = await admin
    .from('barbers')
    .insert({ staff_user_id: staff.id, home_branch_id: branchId, status: 'available' })
    .select('id')
    .single();
  if (barberError) throw barberError;
  const { error: skillError } = await admin
    .from('barber_skills')
    .insert({ barber_id: barber.id, service_id: serviceId });
  if (skillError) throw skillError;
  // Replace any rows the schedule auto-fill may have created, then schedule all day for 16 days.
  await admin.from('barber_schedule').delete().eq('barber_id', barber.id);
  const { error: scheduleError } = await admin.from('barber_schedule').insert(
    Array.from({ length: 16 }, (_, i) => ({
      barber_id: barber.id,
      work_date: dateAt(i),
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
      break_start: withBreak ? '12:00:00' : null,
      break_end: withBreak ? '13:00:00' : null,
    })),
  );
  if (scheduleError) throw scheduleError;
  return { barberId: barber.id, staffUserId: staff.id, authUserId: auth.user.id, email };
}

export async function createAppointmentFixture(): Promise<AppointmentFixture> {
  const { url, serviceRoleKey } = env();
  const admin = createClient<Database>(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const suffix = String(Date.now());
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();

  const { data: service, error: serviceError } = await admin
    .from('services')
    .insert({
      business_id: business!.id,
      name: `Appt Service ${suffix}`,
      default_duration_minutes: 30,
    })
    .select('id')
    .single();
  if (serviceError) throw serviceError;

  const branchId = await createBranch(admin, business!.id, 'Main', suffix);
  const closedBranchId = await createBranch(admin, business!.id, 'Closed', suffix);
  const { data: bs, error: bsError } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: service.id })
    .select('id')
    .single();
  const { data: closedBs, error: closedBsError } = await admin
    .from('branch_services')
    .insert({ branch_id: closedBranchId, service_id: service.id })
    .select('id')
    .single();

  if (bsError) throw bsError;
  if (closedBsError) throw closedBsError;

  const a = await createBarber(admin, 'a', suffix, branchId, service.id, true);
  const b = await createBarber(admin, 'b', suffix, branchId, service.id, false);
  const barberClient = await signIn({ email: a.email });

  const customers: AppointmentFixture['customers'] = [];
  for (let i = 0; i < 4; i++) {
    // 0558… : distinct from the phone ranges other test files use.
    const phone = `+233558${suffix.slice(-5)}${i}`;
    const { data: auth, error } = await admin.auth.admin.createUser({
      phone,
      password: PASSWORD,
      phone_confirm: true,
    });
    if (error) throw error;
    const { data: customer, error: customerError } = await admin
      .from('customers')
      .insert({ auth_user_id: auth.user.id, name: `Appt Customer ${i}`, phone_e164: phone })
      .select('id')
      .single();
    if (customerError) throw customerError;
    customers.push({
      customerId: customer.id,
      authUserId: auth.user.id,
      phone,
      client: await signIn({ phone }),
    });
  }

  return {
    admin,
    suffix,
    serviceId: service.id,
    branchId,
    branchServiceId: bs!.id,
    closedBranchId,
    closedBranchServiceId: closedBs!.id,
    barberA: { barberId: a.barberId, staffUserId: a.staffUserId, authUserId: a.authUserId },
    barberB: { barberId: b.barberId, staffUserId: b.staffUserId, authUserId: b.authUserId },
    barberClient,
    customers,
  };
}

/** Deletes these appointments and the notifications pointing at them (the live cron may have
 * queued reminder texts for any appointment a test creates). Tickets must already be gone. */
export async function deleteAppointmentsByIds(admin: Client, ids: string[]) {
  if (ids.length === 0) return;
  const { error: notificationsError } = await admin
    .from('notifications')
    .delete()
    .in('related_appointment_id', ids);
  if (notificationsError) throw notificationsError;
  const { error } = await admin.from('appointments').delete().in('id', ids);
  if (error) throw error;
}

/** deleteAppointmentsByIds for every appointment at these branches. */
export async function deleteBranchAppointments(admin: Client, branchIds: string[]) {
  const { data, error } = await admin.from('appointments').select('id').in('branch_id', branchIds);
  if (error) throw error;
  await deleteAppointmentsByIds(
    admin,
    (data ?? []).map((a) => a.id),
  );
}

export async function cleanupAppointmentFixture(f: AppointmentFixture) {
  const { admin } = f;
  const branchIds = [f.branchId, f.closedBranchId];
  const { data: tickets } = await admin
    .from('queue_tickets')
    .select('id')
    .in('branch_id', branchIds);
  const ticketIds = (tickets ?? []).map((t) => t.id);
  if (ticketIds.length > 0) {
    await admin.from('feedback').delete().in('ticket_id', ticketIds);
    await admin.from('queue_events').delete().in('ticket_id', ticketIds);
    await admin.from('notifications').delete().in('related_ticket_id', ticketIds);
    await admin.from('queue_tickets').delete().in('id', ticketIds);
  }
  await deleteBranchAppointments(admin, branchIds);
  for (const c of f.customers) {
    await admin.from('customers').delete().eq('id', c.customerId);
    await admin.auth.admin.deleteUser(c.authUserId);
  }
  for (const barber of [f.barberA, f.barberB]) {
    await admin.from('barber_schedule').delete().eq('barber_id', barber.barberId);
    await admin.from('barber_skills').delete().eq('barber_id', barber.barberId);
    await admin.from('staff_users').delete().eq('id', barber.staffUserId);
    await admin.auth.admin.deleteUser(barber.authUserId);
  }
  await admin.from('branch_ticket_counters').delete().in('branch_id', branchIds);
  await admin.from('branch_services').delete().in('branch_id', branchIds);
  await admin.from('branch_closures').delete().in('branch_id', branchIds);
  await admin.from('branch_hours').delete().in('branch_id', branchIds);
  await admin.from('branches').delete().in('id', branchIds);
  await admin.from('services').delete().eq('id', f.serviceId);
}

/** A signed-in branch_manager/receptionist assigned to `branchId` (assignment made before sign-in,
 * so the JWT carries it). */
export async function createStaffLogin(
  f: AppointmentFixture,
  label: string,
  role: 'branch_manager' | 'receptionist',
  branchId: string,
): Promise<{ authUserId: string; staffUserId: string; name: string; client: Client }> {
  const email = `appt-staff-${label}-${f.suffix}@test.pixelbarber.local`;
  const name = `Appt Staff ${label}`;
  const { data: auth, error: authError } = await f.admin.auth.admin.createUser({
    email,
    password: PASSWORD,
    email_confirm: true,
  });
  if (authError) throw authError;
  const { data: staff, error: staffError } = await f.admin
    .from('staff_users')
    .insert({ auth_user_id: auth.user.id, name, email, role, invite_status: 'accepted' })
    .select('id')
    .single();
  if (staffError) throw staffError;
  const { error: assignError } = await f.admin
    .from('staff_branch_assignments')
    .insert({ staff_user_id: staff.id, branch_id: branchId });
  if (assignError) throw assignError;
  return { authUserId: auth.user.id, staffUserId: staff.id, name, client: await signIn({ email }) };
}

/** Call after the test's appointments are deleted and BEFORE cleanupAppointmentFixture
 * (assignments reference the fixture's branches). */
export async function cleanupStaffLogin(
  f: AppointmentFixture,
  login: { authUserId: string; staffUserId: string },
) {
  await f.admin.from('staff_branch_assignments').delete().eq('staff_user_id', login.staffUserId);
  await f.admin.from('staff_users').delete().eq('id', login.staffUserId);
  await f.admin.auth.admin.deleteUser(login.authUserId);
}
