'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';

export default function StaffLoginPage() {
  const router = useRouter();
  const t = useTranslations('Login');
  const supabase = createBrowserSupabaseClient();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    });
    if (signInError) {
      setError(signInError.message);
      return;
    }
    // Route barbers to Today's Queue (Phase 5's own screen) instead of always landing on /tickets --
    // previously only the PIN login path (login/pin/page.tsx) reached /queue/today, so a barber
    // signing in with a password (App Flow 9.1's other login mode) had no path to this phase's screen.
    const { data: staffUser } = await supabase
      .from('staff_users')
      .select('id')
      .eq('auth_user_id', signInData.user!.id)
      .maybeSingle();
    if (staffUser) {
      const { data: barberRow } = await supabase
        .from('barbers')
        .select('id')
        .eq('staff_user_id', staffUser.id)
        .maybeSingle();
      if (barberRow) {
        router.push('/queue/today');
        return;
      }
    }
    router.push('/tickets');
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder={t('emailPlaceholder')}
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder={t('passwordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        <button type="submit">{t('logIn')}</button>
      </form>
      <Link href="/login/pin">{t('pinLoginLink')}</Link>
    </main>
  );
}
