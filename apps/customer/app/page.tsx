'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Branch = Database['public']['Tables']['branches']['Row'];
type BranchStatus = Database['public']['Views']['branch_status_view']['Row'];

interface BranchWithStatus extends Branch {
  status: BranchStatus['status'];
  startingPriceGhs: number | null;
}

export default function Home() {
  const t = useTranslations('BranchDiscovery');
  const [branches, setBranches] = useState<BranchWithStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const supabase = createBrowserSupabaseClient();

  useEffect(() => {
    async function load() {
      const [{ data: branchRows }, { data: statusRows }, { data: branchServiceRows }] =
        await Promise.all([
          supabase.from('branches').select('*'),
          supabase.from('branch_status_view').select('*'),
          supabase.from('branch_services').select('id, branch_id'),
        ]);

      const branchServiceIds = (branchServiceRows ?? []).map((bs) => bs.id);
      const { data: priceRows } = await supabase
        .from('current_branch_service_price')
        .select('branch_service_id, price_ghs')
        .in('branch_service_id', branchServiceIds.length > 0 ? branchServiceIds : ['']);

      const statusByBranch = new Map((statusRows ?? []).map((s) => [s.branch_id, s.status]));
      const branchServiceToBranch = new Map(
        (branchServiceRows ?? []).map((bs) => [bs.id, bs.branch_id]),
      );
      const minPriceByBranch = new Map<string, number>();
      for (const price of priceRows ?? []) {
        if (!price.branch_service_id || price.price_ghs === null) continue;
        const branchId = branchServiceToBranch.get(price.branch_service_id);
        if (!branchId) continue;
        const current = minPriceByBranch.get(branchId);
        if (current === undefined || price.price_ghs < current) {
          minPriceByBranch.set(branchId, price.price_ghs);
        }
      }

      setBranches(
        (branchRows ?? []).map((b) => ({
          ...b,
          status: statusByBranch.get(b.id) ?? 'closed',
          startingPriceGhs: minPriceByBranch.get(b.id) ?? null,
        })),
      );
      setLoading(false);
    }
    load();
  }, []);

  const filtered = useMemo(
    () => branches.filter((b) => b.name.toLowerCase().includes(search.toLowerCase())),
    [branches, search],
  );

  function statusLabel(status: BranchStatus['status']): string {
    switch (status) {
      case 'open':
        return t('statusOpen');
      case 'closing_soon':
        return t('statusClosingSoon');
      case 'temporarily_closed':
        return t('statusTemporarilyClosed');
      default:
        return t('statusClosed');
    }
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      <input
        placeholder={t('searchPlaceholder')}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {!loading && filtered.length === 0 && (
        <div>
          <p>{t('noResults')}</p>
          <button onClick={() => setSearch('')}>{t('clearFilters')}</button>
        </div>
      )}
      <ul>
        {filtered.map((b) => (
          <li key={b.id}>
            <strong>{b.name}</strong> — {statusLabel(b.status)}
            {b.startingPriceGhs !== null && (
              <span> — {t('startingFrom', { price: b.startingPriceGhs.toFixed(2) })}</span>
            )}
            <Link href={`/branches/${b.id}`}>{t('view')}</Link>
          </li>
        ))}
      </ul>
    </main>
  );
}
