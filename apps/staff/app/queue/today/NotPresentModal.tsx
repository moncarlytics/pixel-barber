// apps/staff/app/queue/today/NotPresentModal.tsx
// Phase 5 Task 6: the real Not-Present Confirmation modal (App Flow 9.3, PRD 21), replacing Task
// 5's inline role="alertdialog" stopgap in page.tsx. Shape/structure mirrors Phase 4's
// Cancellation Reason Sheet (apps/customer/app/tickets/[id]/page.tsx): a role="dialog" block with
// a heading, explanatory body text, and Confirm/Back buttons. This component owns no state and
// performs no write itself -- onConfirm is page.tsx's existing confirmNotPresent(ticket), whose
// grace-period computation and updateTicketWithVersion call are unchanged from Task 5.
'use client';

import { useTranslations } from 'next-intl';
import type { Database } from '@pixel-barber/shared';

type Ticket = Database['public']['Tables']['queue_tickets']['Row'];

interface NotPresentModalProps {
  ticket: Ticket;
  onConfirm: (ticket: Ticket) => void | Promise<void>;
  onCancel: () => void;
}

export default function NotPresentModal({ ticket, onConfirm, onCancel }: NotPresentModalProps) {
  const t = useTranslations('TodaysQueue');

  return (
    <div role="dialog" aria-label={t('notPresentConfirmTitle')}>
      <h2>{t('notPresentConfirmTitle')}</h2>
      <p>{t('notPresentConfirmPrompt')}</p>
      <button type="button" onClick={() => onConfirm(ticket)}>
        {t('confirmButton')}
      </button>
      <button type="button" onClick={onCancel}>
        {t('cancelButton')}
      </button>
    </div>
  );
}
