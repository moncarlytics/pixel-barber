'use client';

import { useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  AVATAR_LIBRARY,
  createBrowserSupabaseClient,
  normalizeGhanaPhone,
} from '@pixel-barber/shared';

type Step = 'phone' | 'otp' | 'password' | 'avatar' | 'notifications' | 'welcome';

export default function OnboardWizard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fromBranch = searchParams.get('fromBranch');
  const t = useTranslations('Onboard');
  const supabase = createBrowserSupabaseClient();
  const [step, setStep] = useState<Step>('phone');
  const [name, setName] = useState('');
  const [phoneInput, setPhoneInput] = useState('');
  const [normalizedPhone, setNormalizedPhone] = useState('');
  const [otp, setOtp] = useState('');
  const [password, setPassword] = useState('');
  const [avatarKey, setAvatarKey] = useState('');
  const [pushEnabled, setPushEnabled] = useState(true);
  const [smsBackupEnabled, setSmsBackupEnabled] = useState(true);
  const [leadPrimary, setLeadPrimary] = useState(10);
  const [leadSecondary, setLeadSecondary] = useState(5);
  const [error, setError] = useState<string | null>(null);
  const [resumeCheckComplete, setResumeCheckComplete] = useState(false);

  useEffect(() => {
    // Resume an in-progress onboarding: a customer who verified phone/OTP/password in a
    // previous session but closed the browser before finishing avatar/notifications/welcome
    // should not be forced back through phone entry (which would uselessly re-send an SMS).
    // `avatar_key IS NULL` is the one reliable signal that the avatar step hasn't been
    // completed yet -- there's no equivalent single signal for "notifications step done", so
    // we only ever resume as far as the avatar step. Guarded by the empty dependency array
    // below so this runs once on mount, not on every render.
    let cancelled = false;
    async function checkForResumableSession() {
      const { data: userData } = await supabase.auth.getUser();
      const userId = userData.user?.id;
      if (userId) {
        const { data: customerRow } = await supabase
          .from('customers')
          .select('avatar_key')
          .eq('auth_user_id', userId)
          .maybeSingle();
        if (!cancelled && customerRow && customerRow.avatar_key === null) {
          setStep('avatar');
        }
      }
      if (!cancelled) setResumeCheckComplete(true);
    }
    checkForResumableSession();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (step !== 'welcome') return;
    // Auto-redirect after a brief pause rather than requiring another click -- App Flow
    // section 5 step 6 describes this as "returns the customer directly," not as a screen
    // that waits for input.
    const timeoutId = setTimeout(() => {
      router.push(fromBranch ? `/branches/${fromBranch}` : '/');
    }, 1500);
    return () => clearTimeout(timeoutId);
  }, [step, fromBranch, router]);

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

  if (!resumeCheckComplete) {
    // Avoid a flash of the phone-entry form while the on-mount session-resumption check
    // (above) is still resolving -- rendering it synchronously first would let a resumed
    // customer briefly see (and interact with) step 1 before being redirected to 'avatar'.
    return null;
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
          <div role="radiogroup" aria-label={t('chooseAvatarTitle')}>
            {AVATAR_LIBRARY.map((avatar) => (
              <button
                key={avatar.key}
                type="button"
                role="radio"
                aria-checked={avatarKey === avatar.key}
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
      {step === 'notifications' && (
        <div>
          <h2>{t('notificationsTitle')}</h2>
          <label>
            <input
              type="checkbox"
              checked={pushEnabled}
              onChange={async (e) => {
                const checked = e.target.checked;
                if (checked && typeof window !== 'undefined' && 'Notification' in window) {
                  const permission = await Notification.requestPermission();
                  setPushEnabled(permission === 'granted');
                } else {
                  setPushEnabled(false);
                }
              }}
            />
            {t('enablePush')}
          </label>
          {!pushEnabled && <p>{t('pushPermissionDenied')}</p>}
          <label>
            <input
              type="checkbox"
              checked={smsBackupEnabled}
              onChange={(e) => setSmsBackupEnabled(e.target.checked)}
            />
            {t('smsBackupLabel')}
          </label>
          <label>
            {t('leadTimePrimaryLabel')}
            <input
              type="number"
              value={leadPrimary}
              onChange={(e) => setLeadPrimary(Number(e.target.value))}
              min={1}
              max={60}
            />
          </label>
          <label>
            {t('leadTimeSecondaryLabel')}
            <input
              type="number"
              value={leadSecondary}
              onChange={(e) => setLeadSecondary(Number(e.target.value))}
              min={1}
              max={60}
            />
          </label>
          <button
            type="button"
            onClick={async () => {
              setError(null);
              const { data: userData } = await supabase.auth.getUser();
              const userId = userData.user?.id;
              const { error: prefsError } = await supabase
                .from('customers')
                .update({
                  push_enabled: pushEnabled,
                  sms_backup_enabled: smsBackupEnabled,
                  push_lead_minutes_primary: leadPrimary,
                  push_lead_minutes_secondary: leadSecondary,
                })
                .eq('auth_user_id', userId ?? '');
              if (prefsError) {
                setError(prefsError.message);
                return;
              }
              const { data: customerRow } = await supabase
                .from('customers')
                .select('id')
                .eq('auth_user_id', userId ?? '')
                .single();
              if (customerRow) {
                await supabase.from('consents').insert({
                  customer_id: customerRow.id,
                  consent_type: 'transactional',
                  granted: true,
                  source: 'onboarding_step_5',
                });
              }
              setStep('welcome');
            }}
          >
            {t('finishSetup')}
          </button>
        </div>
      )}
      {step === 'welcome' && (
        <div>
          <h2>{t('welcomeTitle')}</h2>
          <p>{t('welcomeMessage')}</p>
        </div>
      )}
    </main>
  );
}
