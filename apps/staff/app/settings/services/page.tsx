'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Branch = Database['public']['Tables']['branches']['Row'];
type Service = Database['public']['Tables']['services']['Row'];

interface BranchServiceRow {
  branchServiceId: string;
  serviceId: string;
  serviceName: string;
  currentPriceGhs: number | null;
}

export default function ServicesPricingPage() {
  const t = useTranslations('ServicesPricing');
  const supabase = createBrowserSupabaseClient();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState('');
  const [allServices, setAllServices] = useState<Service[]>([]);
  const [branchServices, setBranchServices] = useState<BranchServiceRow[]>([]);
  const [newServiceName, setNewServiceName] = useState('');
  const [newServiceDuration, setNewServiceDuration] = useState('30');
  const [linkServiceId, setLinkServiceId] = useState('');
  const [linkPrice, setLinkPrice] = useState('');
  const [priceEdits, setPriceEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('branches')
      .select('*')
      .then(({ data }) => {
        setBranches(data ?? []);
        const first = data?.[0];
        if (first) setSelectedBranchId(first.id);
      });
    supabase
      .from('services')
      .select('*')
      .then(({ data }) => setAllServices(data ?? []));
  }, []);

  async function loadBranchServices(branchId: string) {
    const { data: bsRows } = await supabase
      .from('branch_services')
      .select('id, service_id, services(name)')
      .eq('branch_id', branchId);
    const branchServiceIds = (bsRows ?? []).map((bs) => bs.id);
    const { data: priceRows } = await supabase
      .from('current_branch_service_price')
      .select('branch_service_id, price_ghs')
      .in('branch_service_id', branchServiceIds.length > 0 ? branchServiceIds : ['']);
    const priceByBs = new Map((priceRows ?? []).map((p) => [p.branch_service_id, p.price_ghs]));
    setBranchServices(
      (bsRows ?? []).map((bs) => ({
        branchServiceId: bs.id,
        serviceId: bs.service_id,
        serviceName: (bs.services as unknown as { name: string } | null)?.name ?? '',
        currentPriceGhs: priceByBs.get(bs.id) ?? null,
      })),
    );
  }

  useEffect(() => {
    if (selectedBranchId) loadBranchServices(selectedBranchId);
    setLinkServiceId('');
    setLinkPrice('');
  }, [selectedBranchId]);

  async function handleAddService(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { data: business } = await supabase.from('businesses').select('id').single();
    if (!business) return;
    const { error: insertError } = await supabase.from('services').insert({
      business_id: business.id,
      name: newServiceName,
      default_duration_minutes: Number(newServiceDuration),
    });
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setNewServiceName('');
    const { data } = await supabase.from('services').select('*');
    setAllServices(data ?? []);
  }

  async function handleLinkService(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { data: bs, error: linkError } = await supabase
      .from('branch_services')
      .insert({ branch_id: selectedBranchId, service_id: linkServiceId })
      .select()
      .single();
    if (linkError) {
      setError(linkError.message);
      return;
    }
    const { error: priceError } = await supabase.from('branch_service_prices').insert({
      branch_service_id: bs.id,
      price_ghs: Number(linkPrice),
      effective_from: new Date().toISOString().slice(0, 10),
    });
    if (priceError) {
      setError(priceError.message);
      loadBranchServices(selectedBranchId);
      return;
    }
    setLinkServiceId('');
    setLinkPrice('');
    loadBranchServices(selectedBranchId);
  }

  async function handleUpdatePrice(branchServiceId: string) {
    setError(null);
    const newPrice = priceEdits[branchServiceId];
    if (!newPrice) return;
    const { error: priceError } = await supabase.from('branch_service_prices').insert({
      branch_service_id: branchServiceId,
      price_ghs: Number(newPrice),
      effective_from: new Date().toISOString().slice(0, 10),
    });
    if (priceError) {
      setError(priceError.message);
      return;
    }
    loadBranchServices(selectedBranchId);
  }

  const linkedServiceIds = new Set(branchServices.map((bs) => bs.serviceId));
  const unlinkedServices = allServices.filter((s) => !linkedServiceIds.has(s.id));

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}

      <label>
        {t('selectBranch')}
        <select value={selectedBranchId} onChange={(e) => setSelectedBranchId(e.target.value)}>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
      </label>

      {branchServices.length === 0 ? (
        <p>{t('noBranchServices')}</p>
      ) : (
        <ul>
          {branchServices.map((bs) => (
            <li key={bs.branchServiceId}>
              {bs.serviceName} — {t('currentPrice')}:{' '}
              {bs.currentPriceGhs !== null ? `GHS ${bs.currentPriceGhs.toFixed(2)}` : '—'}
              <input
                placeholder={t('newPrice')}
                value={priceEdits[bs.branchServiceId] ?? ''}
                onChange={(e) =>
                  setPriceEdits({ ...priceEdits, [bs.branchServiceId]: e.target.value })
                }
              />
              <button onClick={() => handleUpdatePrice(bs.branchServiceId)}>
                {t('updatePrice')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={handleLinkService}>
        <label>
          {t('linkService')}
          <select value={linkServiceId} onChange={(e) => setLinkServiceId(e.target.value)} required>
            <option value="" disabled>
              —
            </option>
            {unlinkedServices.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
        <input
          placeholder={t('linkPrice')}
          value={linkPrice}
          onChange={(e) => setLinkPrice(e.target.value)}
          required
        />
        <button type="submit">{t('linkButton')}</button>
      </form>

      <form onSubmit={handleAddService}>
        <input
          placeholder={t('newServiceName')}
          value={newServiceName}
          onChange={(e) => setNewServiceName(e.target.value)}
          required
        />
        <input
          placeholder={t('newServiceDuration')}
          value={newServiceDuration}
          onChange={(e) => setNewServiceDuration(e.target.value)}
          required
        />
        <button type="submit">{t('addService')}</button>
      </form>
    </main>
  );
}
