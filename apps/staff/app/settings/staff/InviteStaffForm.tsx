// apps/staff/app/settings/staff/InviteStaffForm.tsx
// The Owner's "+ Invite staff" form (App Flow 8.12): name, role, branch (only for roles tied to a
// branch), and a phone number or email. Stays open after sending so the Owner sees the result.
'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { callStaffFunction, deliveryReasonKey, errorText } from './staffFunctions';

const ROLES = ['barber', 'receptionist', 'branch_manager', 'analyst', 'owner'] as const;
type Role = (typeof ROLES)[number];
const BRANCH_ROLES = new Set<Role>(['barber', 'receptionist', 'branch_manager']);

interface Branch {
  id: string;
  name: string;
}

export default function InviteStaffForm({
  onInvited,
  onClose,
}: {
  onInvited: () => void;
  onClose: () => void;
}) {
  const t = useTranslations('StaffRoles');
  const supabase = createBrowserSupabaseClient();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('barber');
  const [branchId, setBranchId] = useState('');
  const [contactType, setContactType] = useState<'phone' | 'email'>('phone');
  const [contact, setContact] = useState('');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    supabase
      .from('branches')
      .select('id, name')
      .order('name')
      .then(({ data }) => {
        if (cancelled) return;
        const branches = (data ?? []) as Branch[];
        setBranches(branches);
        const firstBranch = branches[0];
        if (firstBranch) setBranchId(firstBranch.id);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const needsBranch = BRANCH_ROLES.has(role);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    if (!name.trim()) {
      setResult({ ok: false, text: t('nameRequired') });
      return;
    }
    if (!contact.trim()) {
      setResult({ ok: false, text: t('contactRequired') });
      return;
    }
    setSending(true);
    const response = await callStaffFunction(supabase, 'staff-invite', {
      name: name.trim(),
      role,
      ...(needsBranch ? { branch_id: branchId } : {}),
      [contactType]: contact.trim(),
    });
    setSending(false);

    if (response.status === 201) {
      if (response.body.delivered === true) {
        setResult({
          ok: true,
          text: t(contactType === 'phone' ? 'sentSms' : 'sentEmail', { contact: contact.trim() }),
        });
      } else {
        const reasonKey = deliveryReasonKey(response.body.reason);
        setResult({
          ok: true,
          text: reasonKey ? `${t('notDelivered')} ${t(reasonKey)}` : t('notDelivered'),
        });
      }
      setName('');
      setContact('');
      onInvited();
      return;
    }
    if (response.status === 409) setResult({ ok: false, text: t('contactInUse') });
    else if (response.status === 403) setResult({ ok: false, text: t('noAccess') });
    else {
      setResult({
        ok: false,
        text: t('inviteFailed', { error: errorText(response.body, response.status) }),
      });
    }
  }

  return (
    <section>
      <h2>{t('inviteTitle')}</h2>
      {result && <p role={result.ok ? 'status' : 'alert'}>{result.text}</p>}
      <form onSubmit={handleSubmit}>
        <label>
          {t('nameLabel')}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          {t('roleLabel')}
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`role_${r}`)}
              </option>
            ))}
          </select>
        </label>
        {needsBranch && (
          <label>
            {t('branchLabel')}
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset>
          <legend>{t('contactTypeLabel')}</legend>
          <label>
            <input
              type="radio"
              name="contactType"
              checked={contactType === 'phone'}
              onChange={() => setContactType('phone')}
            />
            {t('contactPhone')}
          </label>
          <label>
            <input
              type="radio"
              name="contactType"
              checked={contactType === 'email'}
              onChange={() => setContactType('email')}
            />
            {t('contactEmail')}
          </label>
        </fieldset>
        <label>
          {contactType === 'phone' ? t('phoneLabel') : t('emailLabel')}
          <input
            type={contactType === 'phone' ? 'tel' : 'email'}
            value={contact}
            onChange={(e) => setContact(e.target.value)}
          />
        </label>
        <button type="submit" disabled={sending}>
          {t('sendInvite')}
        </button>
        <button type="button" onClick={onClose}>
          {t('close')}
        </button>
      </form>
    </section>
  );
}
