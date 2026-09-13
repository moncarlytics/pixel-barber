'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Branch = Database['public']['Tables']['branches']['Row'];
type BranchHour = Database['public']['Tables']['branch_hours']['Row'];
type Barber = Database['public']['Tables']['barbers']['Row'];

interface ServiceRow {
  branchServiceId: string;
  serviceName: string;
  priceGhs: number | null;
}

export default function BranchDetailPage() {
  const t = useTranslations('BranchDetail');
  const params = useParams<{ id: string }>();
  const supabase = createBrowserSupabaseClient();
  const [branch, setBranch] = useState<Branch | null>(null);
  const [hours, setHours] = useState<BranchHour[]>([]);
  const [services, setServices] = useState<ServiceRow[]>([]);
  const [barbers, setBarbers] = useState<Barber[]>([]);

  useEffect(() => {
    async function load() {
      const [{ data: branchRow }, { data: hourRows }, { data: barberRows }, { data: bsRows }] =
        await Promise.all([
          supabase.from('branches').select('*').eq('id', params.id).single(),
          supabase.from('branch_hours').select('*').eq('branch_id', params.id),
          supabase.from('barbers').select('*').eq('home_branch_id', params.id),
          supabase
            .from('branch_services')
            .select('id, service_id, services(name)')
            .eq('branch_id', params.id),
        ]);

      setBranch(branchRow ?? null);
      setHours((hourRows ?? []).sort((a, b) => a.day_of_week - b.day_of_week));
      setBarbers(barberRows ?? []);

      const branchServiceIds = (bsRows ?? []).map((bs) => bs.id);
      const { data: priceRows } = await supabase
        .from('current_branch_service_price')
        .select('branch_service_id, price_ghs')
        .in('branch_service_id', branchServiceIds.length > 0 ? branchServiceIds : ['']);
      const priceByBranchService = new Map(
        (priceRows ?? []).map((p) => [p.branch_service_id, p.price_ghs]),
      );

      setServices(
        (bsRows ?? []).map((bs) => ({
          branchServiceId: bs.id,
          serviceName: (bs.services as unknown as { name: string } | null)?.name ?? '',
          priceGhs: priceByBranchService.get(bs.id) ?? null,
        })),
      );
    }
    load();
  }, [params.id]);

  if (!branch) return null;

  const dayLabels = t.raw('days') as Record<string, string>;

  return (
    <main>
      <Link href="/">{t('back')}</Link>
      <h1>{branch.name}</h1>
      <p>{branch.address}</p>
      {branch.phone_e164 && <p>{branch.phone_e164}</p>}

      <h2>{t('hoursTitle')}</h2>
      <ul>
        {hours.map((h) => (
          <li key={h.id}>
            {dayLabels[String(h.day_of_week)]}:{' '}
            {h.is_closed ? t('closedOnDay') : `${h.opens_at} – ${h.closes_at}`}
          </li>
        ))}
      </ul>

      <h2>{t('servicesTitle')}</h2>
      <ul>
        {services.map((s) => (
          <li key={s.branchServiceId}>
            {s.serviceName}
            {s.priceGhs !== null && ` — GHS ${s.priceGhs.toFixed(2)}`}
          </li>
        ))}
      </ul>

      <h2>{t('barbersTitle')}</h2>
      {barbers.length === 0 ? (
        <p>{t('noBarbers')}</p>
      ) : (
        <ul>
          {barbers.map((b) => (
            <li key={b.id}>{b.id}</li>
          ))}
        </ul>
      )}

      <Link href={`/onboard?fromBranch=${params.id}`}>{t('joinQueue')}</Link>
      <Link href={`/onboard?fromBranch=${params.id}`}>{t('bookAppointment')}</Link>
    </main>
  );
}
