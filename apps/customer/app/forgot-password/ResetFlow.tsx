'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient, normalizeGhanaPhone } from '@pixel-barber/shared';
import { safeNextPath } from '../login/nextPath';

type Step = 'phone' | 'code' | 'password';

const MIN_PASSWORD_LENGTH = 8;

/** Customer password reset: phone → texted code → new password. */
export default function ResetFlow() {
  const t = useTranslations('ForgotPassword');
  const router = useRouter();
  const searchParams = useSearchParams();
  const supabase = useMemo(() => createBrowserSupabaseClient(), []);
  const [step, setStep] = useState<Step>('phone');
  const [phoneInput, setPhoneInput] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [resumeOnboarding, setResumeOnboarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const nextPath = safeNextPath(searchParams.get('next'));

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const normalized = normalizeGhanaPhone(phoneInput);
    if (!normalized) {
      setError(t('invalidPhone'));
      return;
    }
    setBusy(true);
    // shouldCreateUser: false -- a reset never creates an account for an unknown number.
    const { error: otpError } = await supabase.auth.signInWithOtp({
      phone: normalized,
      options: { shouldCreateUser: false },
    });
    setBusy(false);
    if (otpError) {
      setError(otpError.code === 'otp_disabled' ? t('noAccount') : t('sendFailed'));
      return;
    }
    setPhone(normalized);
    setStep('code');
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    const { data, error: verifyError } = await supabase.auth.verifyOtp({
      phone,
      token: code,
      type: 'sms',
    });
    if (verifyError || !data.user) {
      setBusy(false);
      setError(t('badCode'));
      return;
    }

    // Staff logins share the phone sign-in. A staff-only account must never have its password
    // changed from the customer app: sign out of this device only (not the staff member's other
    // sessions) and stop here.
    const { data: customer, error: customerError } = await supabase
      .from('customers')
      .select('avatar_key')
      .eq('auth_user_id', data.user.id)
      .maybeSingle();
    if (customerError || !customer) {
      await supabase.auth.signOut({ scope: 'local' });
      setBusy(false);
      setCode('');
      setStep('phone');
      setError(customerError ? t('failed') : t('noAccount'));
      return;
    }
    setResumeOnboarding(customer.avatar_key === null);
    setBusy(false);
    setStep('password');
  }

  async function handleSavePassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t('passwordTooShort', { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    setBusy(true);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setBusy(false);
      setError(t('failed'));
      return;
    }
    // Signed up but never finished (no avatar yet): the onboarding wizard resumes from there.
    router.push(resumeOnboarding ? '/onboard' : nextPath);
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}

      {step === 'phone' && (
        <form onSubmit={handleSendCode}>
          <p>{t('phoneIntro')}</p>
          <input
            placeholder={t('phonePlaceholder')}
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            inputMode="tel"
            autoComplete="tel"
            required
          />
          <button type="submit" disabled={busy}>
            {t('sendCode')}
          </button>
        </form>
      )}

      {step === 'code' && (
        <form onSubmit={handleVerify}>
          <p>{t('codeIntro')}</p>
          <input
            placeholder={t('codePlaceholder')}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            inputMode="numeric"
            autoComplete="one-time-code"
            required
          />
          <button type="submit" disabled={busy}>
            {t('verify')}
          </button>
        </form>
      )}

      {step === 'password' && (
        <form onSubmit={handleSavePassword}>
          <input
            type="password"
            placeholder={t('passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            required
          />
          <button type="submit" disabled={busy}>
            {t('savePassword')}
          </button>
        </form>
      )}

      <Link href="/login">{t('backToLogin')}</Link>
    </main>
  );
}
