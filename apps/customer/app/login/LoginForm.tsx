'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient, normalizeGhanaPhone } from '@pixel-barber/shared';
import { safeNextPath } from './nextPath';

export default function LoginForm() {
  const t = useTranslations('Login');
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [phoneInput, setPhoneInput] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const nextPath = safeNextPath(searchParams.get('next'));
  const sessionEnded = searchParams.get('reason') === 'session';

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const phone = normalizeGhanaPhone(phoneInput);
    if (!phone) {
      setError(t('invalidPhone'));
      return;
    }
    setSubmitting(true);
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      phone,
      password,
    });
    if (signInError || !data.user) {
      setError(signInError?.message === 'Invalid login credentials' ? t('incorrect') : t('failed'));
      setSubmitting(false);
      return;
    }

    // Staff logins (e.g. an SMS-invited barber) share the phone sign-in but have no customer
    // profile -- they must not end up in the customer app.
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('avatar_key')
      .eq('auth_user_id', data.user.id)
      .maybeSingle();
    if (customerError || !customer) {
      // This device only: a staff member's other sessions (e.g. a barber station) stay signed in.
      await supabase.auth.signOut({ scope: 'local' });
      setError(customerError ? t('failed') : t('noCustomerAccount'));
      setSubmitting(false);
      return;
    }

    // Signed up but never finished (no avatar yet): the onboarding wizard resumes from there.
    router.push(customer.avatar_key === null ? '/onboard' : nextPath);
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {sessionEnded && <p>{t('sessionEnded')}</p>}
      {error && <p role="alert">{error}</p>}
      <form onSubmit={handleSubmit}>
        <input
          placeholder={t('phonePlaceholder')}
          value={phoneInput}
          onChange={(e) => setPhoneInput(e.target.value)}
          inputMode="tel"
          autoComplete="tel"
          required
        />
        <input
          type="password"
          placeholder={t('passwordPlaceholder')}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <button type="submit" disabled={submitting}>
          {t('submit')}
        </button>
      </form>
      <Link
        href={
          searchParams.get('next')
            ? `/forgot-password?next=${encodeURIComponent(nextPath)}`
            : '/forgot-password'
        }
      >
        {t('forgotPassword')}
      </Link>
      <Link href="/onboard">{t('newHere')}</Link>
    </main>
  );
}
