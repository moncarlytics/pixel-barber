'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AVATAR_LIBRARY,
  createBrowserSupabaseClient,
  normalizeGhanaPhone,
} from '@pixel-barber/shared';

type Step = 'phone' | 'otp' | 'password' | 'avatar' | 'notifications' | 'welcome';

export default function OnboardPage() {
  const router = useRouter();
  const t = useTranslations('Onboard');
  const supabase = createBrowserSupabaseClient();
  const [step, setStep] = useState<Step>('phone');
  const [name, setName] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [normalizedPhone, setNormalizedPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [avatarKey, setAvatarKey] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function handlePhoneSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const normalized = normalizeGhanaPhone(phoneInput);
    if (!normalized) {
      setError(t('invalidPhone'));
      return;
    }
    const { error: otpError } = await supabase.auth.signInWithOtp({ phone: normalized });
    if (otpError) {
      setError(otpError.message);
      return;
    }
    setNormalizedPhone(normalized);
    setStep('otp');
  }

  async function handleOtpSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: verifyError } = await supabase.auth.verifyOtp({
      phone: normalizedPhone,
      token: otp,
      type: 'sms',
    });
    if (verifyError) {
      setError(verifyError.message);
      return;
    }
    setStep('password');
  }

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) {
      setError(updateError.message);
      return;
    }
    const { error: linkError } = await supabase.rpc('link_or_create_customer', {
      p_name: name,
    });
    if (linkError) {
      setError(linkError.message);
      return;
    }
    setStep('avatar');
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}
      {step === 'phone' && (
        <form onSubmit={handlePhoneSubmit}>
          <input
            placeholder={t('namePlaceholder')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <input
            placeholder={t('phonePlaceholder')}
            value={phoneInput}
            onChange={(e) => setPhoneInput(e.target.value)}
            required
          />
          <button type="submit">{t('sendCode')}</button>
        </form>
      )}
      {step === 'otp' && (
        <form onSubmit={handleOtpSubmit}>
          <input
            placeholder={t('otpPlaceholder')}
            value={otp}
            onChange={(e) => setOtp(e.target.value)}
            required
          />
          <button type="submit">{t('verify')}</button>
        </form>
      )}
      {step === 'password' && (
        <form onSubmit={handlePasswordSubmit}>
          <input
            type="password"
            placeholder={t('passwordPlaceholder')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          <button type="submit">{t('finish')}</button>
        </form>
      )}
      {step === 'avatar' && (
        <div>
          <h2>{t('chooseAvatarTitle')}</h2>
          <div role="radiogroup">
            {AVATAR_LIBRARY.map((avatar) => (
              <button
                key={avatar.key}
                type="button"
                aria-pressed={avatarKey === avatar.key}
                onClick={() => setAvatarKey(avatar.key)}
              >
                {avatar.emoji} {avatar.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={!avatarKey}
            onClick={async () => {
              setError(null);
              const { error: avatarError } = await supabase
                .from('customers')
                .update({ avatar_key: avatarKey })
                .eq('auth_user_id', (await supabase.auth.getUser()).data.user?.id ?? '');
              if (avatarError) {
                setError(avatarError.message);
                return;
              }
              setStep('notifications');
            }}
          >
            {t('continueButton')}
          </button>
        </div>
      )}
    </main>
  );
}
