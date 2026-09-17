// apps/staff/app/login/pin/page.tsx
// Barber shared-station PIN login (App Flow 9.1). A sibling entry point to the standard staff
// login, not a replacement -- for a tablet/kiosk at the front desk where a barber picks their
// branch and types a 4-6 digit PIN instead of email+password. `pin-login` (backend-schema 3.3)
// mints a REAL Supabase session server-side; supabase.auth.setSession(...) here adopts that
// externally-obtained session pair exactly the way the standard login page's
// signInWithPassword(...) leaves the client afterward -- same session shape, same redirect target,
// indistinguishable to every other screen in the app.
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Branch = Database['public']['Tables']['branches']['Row'];

export default function BarberPinLoginPage() {
  const router = useRouter();
  const t = useTranslations('PinLogin');
  const supabase = createBrowserSupabaseClient();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    supabase
      .from('branches')
      .select('*')
      .order('name')
      .then(({ data }) => {
        setBranches(data ?? []);
        setBranchId((current) => current || data?.[0]?.id || '');
      });
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const response = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/pin-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ branch_id: branchId, pin }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || !body.access_token || !body.refresh_token) {
      setError(t('invalidPin'));
      return;
    }
    const { error: setSessionError } = await supabase.auth.setSession({
      access_token: body.access_token,
      refresh_token: body.refresh_token,
    });
    if (setSessionError) {
      setError(t('invalidPin'));
      return;
    }
    router.push('/queue/today');
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={handleSubmit}>
        <label>
          {t('branchLabel')}
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} required>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
        <input
          type="password"
          inputMode="numeric"
          placeholder={t('pinPlaceholder')}
          value={pin}
          onChange={(e) => setPin(e.target.value)}
          minLength={4}
          maxLength={6}
          required
        />
        <button type="submit">{t('logIn')}</button>
      </form>
      <Link href="/login">{t('backToLoginLink')}</Link>
    </main>
  );
}
