// apps/staff/app/settings/staff/page.tsx
// Settings → Staff & Roles (App Flow 8.12, PRD §46): Owner-only list of every staff account with
// its invite/account status, per-row Resend/Revoke/Deactivate/Reactivate, and the Invite form.
'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { Database } from '@pixel-barber/shared';
import InviteStaffForm from './InviteStaffForm';
import { callStaffFunction, deliveryReasonKey, errorText } from './staffFunctions';

type StaffAccount = Database['public']['Functions']['list_staff_accounts']['Returns'][number];
type ManageAction = 'resend' | 'revoke' | 'deactivate' | 'reactivate';

function actionsFor(account: StaffAccount): ManageAction[] {
  switch (account.status) {
    case 'invite_pending':
    case 'invite_expired':
      return ['resend', 'revoke'];
    case 'active':
      return account.is_self ? [] : ['deactivate'];
    case 'deactivated':
      return ['reactivate'];
    default:
      return [];
  }
}

export default function StaffRolesPage() {
  const t = useTranslations('StaffRoles');
  const supabase = createBrowserSupabaseClient();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [accounts, setAccounts] = useState<StaffAccount[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [rowMessages, setRowMessages] = useState<Record<string, string>>({});
  const [busyRow, setBusyRow] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('list_staff_accounts');
    setLoadError(!!error);
    if (!error) setAccounts(data ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let cancelled = false;
    supabase.rpc('has_capability', { cap: 'manage_staff' }).then(({ data }) => {
      if (cancelled) return;
      setAllowed(data === true);
      if (data === true) void load();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function runAction(account: StaffAccount, action: ManageAction) {
    if (
      action === 'deactivate' &&
      !window.confirm(t('confirmDeactivate', { name: account.name }))
    ) {
      return;
    }
    setBusyRow(account.staff_user_id);
    const response = await callStaffFunction(supabase, 'staff-manage', {
      action,
      staff_user_id: account.staff_user_id,
    });
    setBusyRow(null);
    let message = '';
    if (response.status !== 200) {
      message = t('actionFailed', { error: errorText(response.body, response.status) });
    } else if (action === 'resend') {
      if (response.body.delivered === true) {
        message = t('resent');
      } else {
        const reasonKey = deliveryReasonKey(response.body.reason);
        message = reasonKey ? `${t('notDelivered')} ${t(reasonKey)}` : t('notDelivered');
      }
    }
    setRowMessages((m) => ({ ...m, [account.staff_user_id]: message }));
    await load();
  }

  if (allowed === null) return null;
  if (!allowed) {
    return (
      <main>
        <p role="alert">{t('noAccess')}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      {loadError && <p role="alert">{t('loadFailed')}</p>}
      {showInvite ? (
        <InviteStaffForm onInvited={() => void load()} onClose={() => setShowInvite(false)} />
      ) : (
        <button type="button" onClick={() => setShowInvite(true)}>
          {t('openInvite')}
        </button>
      )}
      <table>
        <thead>
          <tr>
            <th>{t('colName')}</th>
            <th>{t('colRole')}</th>
            <th>{t('colBranch')}</th>
            <th>{t('colContact')}</th>
            <th>{t('colStatus')}</th>
            <th>{t('colActions')}</th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((account) => (
            <tr key={account.staff_user_id}>
              <td>{account.name}</td>
              <td>{t(`role_${account.role}`)}</td>
              <td>{account.branch_name ?? t('allBranches')}</td>
              <td>{account.phone_e164 ?? account.email}</td>
              <td>{t(`status_${account.status}`)}</td>
              <td>
                {actionsFor(account).map((action) => (
                  <button
                    key={action}
                    type="button"
                    disabled={busyRow === account.staff_user_id}
                    onClick={() => runAction(account, action)}
                  >
                    {t(action)}
                  </button>
                ))}
                {rowMessages[account.staff_user_id] && (
                  <span role="status"> {rowMessages[account.staff_user_id]}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
