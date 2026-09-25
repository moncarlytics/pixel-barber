'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { parseLoginIdentifier } from './identifier';
import { postLoginPath } from './postLoginPath';

export default function StaffLoginPage() {
  const router = useRouter();
  const t = useTranslations('Login');
  const supabase = createBrowserSupabaseClient();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const login = parseLoginIdentifier(identifier);
    if (!login) {
      setError(t('invalidIdentifier'));
      return;
    }
    const { data: signInData, error: signInError } = await supabase.auth.signInWithPassword(
      'email' in login ? { email: login.email, password } : { phone: login.phone, password },
    );
    if (signInError) {
      setError(t('signInFailed'));
      return;
    }
    // Barbers land on Today's Queue, everyone else on /tickets (shared with Accept Invite).
    router.push(await postLoginPath(supabase, signInData.user!.id));
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={handleSubmit}>
        <input
          type="text"
          autoComplete="username"
          placeholder={t('identifierPlaceholder')}
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
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
