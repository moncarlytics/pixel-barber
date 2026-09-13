'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Branch = Database['public']['Tables']['branches']['Row'];

export default function BranchListPage() {
  const t = useTranslations('BranchSettings');
  const supabase = createBrowserSupabaseClient();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [name, setName] = useState('');
  const [branchCode, setBranchCode] = useState('');
  const [address, setAddress] = useState('');
  const [latitude, setLatitude] = useState('');
  const [longitude, setLongitude] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function loadBranches() {
    const { data } = await supabase.from('branches').select('*');
    setBranches(data ?? []);
  }

  useEffect(() => {
    loadBranches();
  }, []);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { data: business } = await supabase.from('businesses').select('id').single();
    if (!business) {
      setError('No business row found.');
      return;
    }
    const { error: insertError } = await supabase.from('branches').insert({
      business_id: business.id,
      name,
      branch_code: branchCode,
      address,
      latitude: Number(latitude),
      longitude: Number(longitude),
    });
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setName('');
    setBranchCode('');
    setAddress('');
    setLatitude('');
    setLongitude('');
    loadBranches();
  }

  return (
    <main>
      <h1>{t('listTitle')}</h1>
      {error && <p role="alert">{error}</p>}
      <ul>
        {branches.map((b) => (
          <li key={b.id}>
            <Link href={`/settings/branch/${b.id}`}>{b.name}</Link>
          </li>
        ))}
      </ul>

      <h2>{t('newBranch')}</h2>
      <form onSubmit={handleCreate}>
        <input
          placeholder={t('name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <input
          placeholder={t('branchCode')}
          value={branchCode}
          onChange={(e) => setBranchCode(e.target.value)}
          required
        />
        <input
          placeholder={t('address')}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
          required
        />
        <input
          placeholder={t('latitude')}
          value={latitude}
          onChange={(e) => setLatitude(e.target.value)}
          required
        />
        <input
          placeholder={t('longitude')}
          value={longitude}
          onChange={(e) => setLongitude(e.target.value)}
          required
        />
        <button type="submit">{t('create')}</button>
      </form>
    </main>
  );
}
