// tests/db/find-eligible-barber.test.ts
// @vitest-environment node
// New Task 1: find_eligible_barber is the single source of truth for "which barber does this
// customer get" -- covers skill matching, the branch_schedule shift-hours window, each excluded
// barber_status value, least-busy tie-breaking, and the preferred-barber eligibility/scheduled
// distinctions the join-flow prompt depends on.
import { config } from 'dotenv';
config({ path: '.env.local' });
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient } from '@supabase/supabase-js';
import type { Database } from '@pixel-barber/shared';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient<Database>(url, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const suffix = Date.now();
const today = new Date().toISOString().slice(0, 10);

// A shift window guaranteed NOT to cover the current wall-clock time, but that has NOT yet
// ended either, for the "outside shift hours (shift is later today)" case -- computed relative
// to "now" rather than hardcoded, so this test isn't flaky depending on what time it happens to
// run. Starting a few minutes from now and running to the end of the day (rather than the
// original fixed 1-hour-window-5-hours-out approach) avoids wrapping past midnight, which used
// to make shift_end look like it was already in the past (as a bare TIME, with no date
// component) whenever "now" was within 5 hours of midnight -- exactly the ambiguity
// find_eligible_barber's new "shift hasn't already ended" check now cares about.
const now = new Date();
const startMinutes = Math.min(now.getHours() * 60 + now.getMinutes() + 5, 23 * 60 + 58);
const outsideStart = `${String(Math.floor(startMinutes / 60)).padStart(2, '0')}:${String(
  startMinutes % 60,
).padStart(2, '0')}:00`;
const outsideEnd = '23:59:59';

// A shift that has ALREADY ENDED as of "now" (final review Problem 2: find_eligible_barber must
// treat an ended shift as making the barber no longer "scheduled today" for wait-vs-fallback
// purposes) -- also computed relative to "now" to avoid a hardcoded, flaky time.
const endedMinutes = Math.max(now.getHours() * 60 + now.getMinutes() - 5, 1);
const endedShiftEnd = `${String(Math.floor(endedMinutes / 60)).padStart(2, '0')}:${String(
  endedMinutes % 60,
).padStart(2, '0')}:00`;

let branchId: string;
let branchServiceId: string; // barbers ARE skilled for this one
let otherBranchServiceId: string; // barbers are NOT skilled for this one
let serviceId: string;
let otherServiceId: string;

interface TestBarber {
  staffUserId: string;
  authUserId: string;
  barberId: string;
}
const barbers: Record<string, TestBarber> = {};

async function makeBarber(label: string): Promise<TestBarber> {
  const email = `feb-${label}-${suffix}@test.pixelbarber.local`;
  const { data: authUser } = await admin.auth.admin.createUser({
    email,
    password: 'Test-Password-123!',
    email_confirm: true,
  });
  const { data: staffRow } = await admin
    .from('staff_users')
    .insert({
      auth_user_id: authUser!.user.id,
      name: `FEB Test Barber ${label}`,
      email,
      role: 'barber',
      invite_status: 'accepted',
    })
    .select()
    .single();
  const { data: barberRow } = await admin
    .from('barbers')
    .insert({ staff_user_id: staffRow!.id, home_branch_id: branchId, status: 'available' })
    .select()
    .single();
  return { staffUserId: staffRow!.id, authUserId: authUser!.user.id, barberId: barberRow!.id };
}

beforeAll(async () => {
  const { data: business } = await admin.from('businesses').select('id').limit(1).single();
  const { data: service } = await admin.from('services').select('id').limit(1).single();
  serviceId = service!.id;
  const { data: otherService } = await admin
    .from('services')
    .select('id')
    .neq('id', serviceId)
    .limit(1)
    .single();
  otherServiceId = otherService!.id;

  const { data: branch } = await admin
    .from('branches')
    .insert({
      business_id: business!.id,
      name: 'Find Eligible Barber Test Branch',
      branch_code: `FEB${suffix % 100000}`,
      address: 'Test',
      latitude: 5.6,
      longitude: -0.18,
    })
    .select()
    .single();
  branchId = branch!.id;

  const { data: bs } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: serviceId })
    .select()
    .single();
  branchServiceId = bs!.id;
  const { data: otherBs } = await admin
    .from('branch_services')
    .insert({ branch_id: branchId, service_id: otherServiceId })
    .select()
    .single();
  otherBranchServiceId = otherBs!.id;

  // Barber A: fully eligible -- skilled, scheduled all day today, available, no active tickets.
  barbers.a = await makeBarber('a');
  // Barber B: fully eligible too, but with 2 pre-existing active tickets (busier than A).
  barbers.b = await makeBarber('b');
  // Barber C: skilled and scheduled, but status = offline -- excluded.
  barbers.c = await makeBarber('c');
  // Barber D: skilled and scheduled, but status = on_break -- still eligible.
  barbers.d = await makeBarber('d');
  // Barber E: skilled, scheduled today, but current time falls OUTSIDE their shift hours.
  barbers.e = await makeBarber('e');
  // Barber F: skilled, but has NO schedule row for today at all.
  barbers.f = await makeBarber('f');
  // Barber G: scheduled and available, but has NO barber_skills row for this service.
  barbers.g = await makeBarber('g');
  // Barber H: skilled, but their shift for today has ALREADY ENDED (final review Problem 2).
  barbers.h = await makeBarber('h');

  await admin.from('barber_skills').insert([
    { barber_id: barbers.a.barberId, service_id: serviceId },
    { barber_id: barbers.b.barberId, service_id: serviceId },
    { barber_id: barbers.c.barberId, service_id: serviceId },
    { barber_id: barbers.d.barberId, service_id: serviceId },
    { barber_id: barbers.e.barberId, service_id: serviceId },
    { barber_id: barbers.f.barberId, service_id: serviceId },
    // g deliberately has no barber_skills row for `serviceId` -- only `otherServiceId`.
    { barber_id: barbers.g.barberId, service_id: otherServiceId },
    { barber_id: barbers.h.barberId, service_id: serviceId },
  ]);

  await admin.from('barber_schedule').insert([
    {
      barber_id: barbers.a.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    },
    {
      barber_id: barbers.b.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    },
    {
      barber_id: barbers.c.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    },
    {
      barber_id: barbers.d.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    },
    {
      barber_id: barbers.e.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: outsideStart,
      shift_end: outsideEnd,
    },
    // f deliberately gets no barber_schedule row at all.
    {
      barber_id: barbers.g.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: '23:59:59',
    },
    {
      barber_id: barbers.h.barberId,
      work_date: today,
      branch_id: branchId,
      shift_start: '00:00:00',
      shift_end: endedShiftEnd,
    },
  ]);

  await admin.from('barbers').update({ status: 'offline' }).eq('id', barbers.c.barberId);
  await admin.from('barbers').update({ status: 'on_break' }).eq('id', barbers.d.barberId);

  // Create tickets to establish clear load ordering: A=0, D=1, B=2.
  // This makes the least-busy test deterministic (A is strictly least busy).
  const { data: cust1 } = await admin
    .from('customers')
    .insert({ name: 'FEB Customer 1', phone_e164: `+233${String(suffix).slice(-8)}1` })
    .select()
    .single();
  const { data: cust2 } = await admin
    .from('customers')
    .insert({ name: 'FEB Customer 2', phone_e164: `+233${String(suffix).slice(-8)}2` })
    .select()
    .single();
  const { data: cust3 } = await admin
    .from('customers')
    .insert({ name: 'FEB Customer 3', phone_e164: `+233${String(suffix).slice(-8)}3` })
    .select()
    .single();
  await admin.from('queue_tickets').insert([
    {
      ticket_number: `PB-FEB-1-${suffix}`,
      branch_id: branchId,
      customer_id: cust1!.id,
      branch_service_id: branchServiceId,
      assigned_barber_id: barbers.b.barberId,
      state: 'waiting',
      created_by: 'staff',
    },
    {
      ticket_number: `PB-FEB-2-${suffix}`,
      branch_id: branchId,
      customer_id: cust2!.id,
      branch_service_id: branchServiceId,
      assigned_barber_id: barbers.b.barberId,
      state: 'in_service',
      created_by: 'staff',
    },
    {
      ticket_number: `PB-FEB-3-${suffix}`,
      branch_id: branchId,
      customer_id: cust3!.id,
      branch_service_id: branchServiceId,
      assigned_barber_id: barbers.d.barberId,
      state: 'waiting',
      created_by: 'staff',
    },
  ]);
}, 60000);

afterAll(async () => {
  await admin.from('queue_tickets').delete().eq('branch_id', branchId);
  await admin
    .from('customers')
    .delete()
    .like('phone_e164', `+233${String(suffix).slice(-8)}%`);
  await admin.from('barber_schedule').delete().eq('branch_id', branchId);
  await admin
    .from('barber_skills')
    .delete()
    .in(
      'barber_id',
      Object.values(barbers).map((b) => b.barberId),
    );
  const staffUserIds = Object.values(barbers).map((b) => b.staffUserId);
  await admin.from('staff_users').delete().in('id', staffUserIds);
  for (const b of Object.values(barbers)) {
    await admin.auth.admin.deleteUser(b.authUserId);
  }
  await admin.from('branches').delete().eq('id', branchId);
}, 60000);

describe('find_eligible_barber', () => {
  it('excludes a barber with no barber_skills row for the service', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: otherBranchServiceId,
      p_preferred_barber_id: barbers.g.barberId,
    });
    // g IS skilled for otherServiceId, so g itself should be eligible here -- but none of the
    // OTHER barbers (a/b/c/d/e/f) are skilled for otherServiceId, so g must be the only
    // possible fallback candidate too.
    expect(data![0].fallback_barber_id).toBe(barbers.g.barberId);
  });

  it('excludes an offline barber and still includes an on_break barber', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.c.barberId, // offline
    });
    expect(data![0].preferred_eligible).toBe(false);
    expect(data![0].preferred_scheduled_today).toBe(true); // has a schedule row, just offline

    const { data: dData } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.d.barberId, // on_break
    });
    expect(dData![0].preferred_eligible).toBe(true);
  });

  it('excludes a barber whose schedule does not cover the current time', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.e.barberId,
    });
    expect(data![0].preferred_eligible).toBe(false);
    expect(data![0].preferred_scheduled_today).toBe(true);
  });

  it('reports preferred_scheduled_today = false when there is no schedule row at all', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.f.barberId,
    });
    expect(data![0].preferred_eligible).toBe(false);
    expect(data![0].preferred_scheduled_today).toBe(false);
  });

  it('reports preferred_scheduled_today = false for a scheduled barber who lacks the skill (final review Problem 2)', async () => {
    // g has a barber_schedule row for branchServiceId's branch/date but no barber_skills row for
    // `serviceId` (only for `otherServiceId`) -- before this fix, a schedule-row-only check would
    // have wrongly reported preferred_scheduled_today = true here.
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.g.barberId,
    });
    expect(data![0].preferred_eligible).toBe(false);
    expect(data![0].preferred_scheduled_today).toBe(false);
  });

  it('reports preferred_scheduled_today = false for a barber whose shift has already ended (final review Problem 2)', async () => {
    // h is skilled and has a schedule row for today, but shift_end is a few minutes in the past --
    // before this fix, a schedule-row-only check would have wrongly reported
    // preferred_scheduled_today = true here, offering "wait for this barber" for someone who can
    // never become eligible again today.
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.h.barberId,
    });
    expect(data![0].preferred_eligible).toBe(false);
    expect(data![0].preferred_scheduled_today).toBe(false);
  });

  it('picks the least-busy eligible barber as the fallback', async () => {
    // Ticket counts: A=0, D=1, B=2. Without this ordering, A and D would tie on active_count
    // and fall through to barber_id uuid tie-break (random, ~50/50), making the test flaky.
    // The single D ticket ensures A is strictly the least-busy fallback.
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: null,
    });
    expect(data![0].fallback_barber_id).toBe(barbers.a.barberId);
  });

  it('reports preferred_eligible = true for a genuinely eligible preferred barber', async () => {
    const { data } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: branchServiceId,
      p_preferred_barber_id: barbers.a.barberId,
    });
    expect(data![0].preferred_eligible).toBe(true);
  });

  it('returns a null fallback_barber_id when nobody is eligible', async () => {
    // Only g is skilled for otherServiceId; make g temporarily ineligible too to hit the true
    // empty-pool case.
    await admin.from('barbers').update({ status: 'offline' }).eq('id', barbers.g.barberId);
    const { data: emptyPool } = await admin.rpc('find_eligible_barber', {
      p_branch_id: branchId,
      p_branch_service_id: otherBranchServiceId,
      p_preferred_barber_id: null,
    });
    expect(emptyPool![0].fallback_barber_id).toBeNull();
    await admin.from('barbers').update({ status: 'available' }).eq('id', barbers.g.barberId);
  });
});
