'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient, AVATAR_LIBRARY } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';

type Customer = Database['public']['Tables']['customers']['Row'];
type Branch = Database['public']['Tables']['branches']['Row'];

export default function ProfilePage() {
  const t = useTranslations('Profile');
  const router = useRouter();
  const supabase = createBrowserSupabaseClient();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [marketingConsent, setMarketingConsent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  async function load() {
    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;
    if (!userId) {
      router.push('/onboard');
      return;
    }
    const { data: customerRow } = await supabase
      .from('customers')
      .select('*')
      .eq('auth_user_id', userId)
      .single();
    setCustomer(customerRow ?? null);

    const { data: branchRows } = await supabase.from('branches').select('*').order('name');
    setBranches(branchRows ?? []);

    if (customerRow) {
      const { data: latestConsent } = await supabase
        .from('consents')
        .select('granted')
        .eq('customer_id', customerRow.id)
        .eq('consent_type', 'marketing')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      setMarketingConsent(latestConsent?.granted ?? false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleSaveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!customer) return;
    setError(null);
    setSaved(false);
    const { error: updateError } = await supabase
      .from('customers')
      .update({
        name: customer.name,
        email: customer.email,
        avatar_key: customer.avatar_key,
        preferred_branch_id: customer.preferred_branch_id,
        push_enabled: customer.push_enabled,
        sms_backup_enabled: customer.sms_backup_enabled,
        push_lead_minutes_primary: customer.push_lead_minutes_primary,
        push_lead_minutes_secondary: customer.push_lead_minutes_secondary,
      })
      .eq('id', customer.id);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setSaved(true);
  }

  async function handleMarketingConsentChange(checked: boolean) {
    if (!customer) return;
    setError(null);
    const { error: consentError } = await supabase.from('consents').insert({
      customer_id: customer.id,
      consent_type: 'marketing',
      granted: checked,
      source: 'profile_settings',
    });
    if (consentError) {
      setError(consentError.message);
      return;
    }
    setMarketingConsent(checked);
  }

  async function handleLogout() {
    await supabase.auth.signOut();
    router.push('/');
  }

  if (!customer) return null;

  return (
    <main>
      <h1>{t('title')}</h1>
      {error && <p role="alert">{error}</p>}
      {saved && <p>{t('saved')}</p>}

      <h2>{t('accountInfoTitle')}</h2>
      <form onSubmit={handleSaveProfile}>
        <label>
          {t('name')}
          <input
            value={customer.name}
            onChange={(e) => setCustomer({ ...customer, name: e.target.value })}
          />
        </label>
        <p>
          {t('phone')}: {customer.phone_e164}
        </p>
        <label>
          {t('email')}
          <input
            value={customer.email ?? ''}
            onChange={(e) => setCustomer({ ...customer, email: e.target.value })}
          />
        </label>

        <h2>{t('avatarTitle')}</h2>
        <div role="radiogroup" aria-label={t('avatarTitle')}>
          {AVATAR_LIBRARY.map((avatar) => (
            <button
              key={avatar.key}
              type="button"
              role="radio"
              aria-checked={customer.avatar_key === avatar.key}
              title={avatar.label}
              onClick={() => setCustomer({ ...customer, avatar_key: avatar.key })}
            >
              {avatar.emoji} {avatar.label}
            </button>
          ))}
        </div>

        <h2>{t('notificationsTitle')}</h2>
        <label>
          <input
            type="checkbox"
            checked={customer.push_enabled}
            onChange={async (e) => {
              const checked = e.target.checked;
              if (checked && typeof window !== 'undefined' && 'Notification' in window) {
                const permission = await Notification.requestPermission();
                setCustomer({ ...customer, push_enabled: permission === 'granted' });
              } else {
                setCustomer({ ...customer, push_enabled: false });
              }
            }}
          />
          {t('enablePush')}
        </label>
        <label>
          <input
            type="checkbox"
            checked={customer.sms_backup_enabled}
            onChange={(e) => setCustomer({ ...customer, sms_backup_enabled: e.target.checked })}
          />
          {t('smsBackup')}
        </label>
        <label>
          {t('leadTimePrimary')}
          <input
            type="number"
            value={customer.push_lead_minutes_primary}
            onChange={(e) =>
              setCustomer({ ...customer, push_lead_minutes_primary: Number(e.target.value) })
            }
            min={1}
            max={60}
          />
        </label>
        <label>
          {t('leadTimeSecondary')}
          <input
            type="number"
            value={customer.push_lead_minutes_secondary}
            onChange={(e) =>
              setCustomer({ ...customer, push_lead_minutes_secondary: Number(e.target.value) })
            }
            min={1}
            max={60}
          />
        </label>

        <h2>{t('defaultBranchTitle')}</h2>
        <select
          value={customer.preferred_branch_id ?? ''}
          onChange={(e) =>
            setCustomer({ ...customer, preferred_branch_id: e.target.value || null })
          }
        >
          <option value="">{t('noBranchSelected')}</option>
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>

        <button type="submit">{t('save')}</button>
      </form>

      <h2>{t('languageTitle')}</h2>
      <p>{t('languageValue')}</p>

      <h2>{t('marketingConsentTitle')}</h2>
      <label>
        <input
          type="checkbox"
          checked={marketingConsent}
          onChange={(e) => handleMarketingConsentChange(e.target.checked)}
        />
        {t('marketingConsentLabel')}
      </label>

      <h2>{t('visitHistoryTitle')}</h2>
      <p>{t('noVisits')}</p>

      <h2>{t('feedbackHistoryTitle')}</h2>
      <p>{t('noFeedback')}</p>

      <button type="button" onClick={handleLogout}>
        {t('logOut')}
      </button>
    </main>
  );
}
