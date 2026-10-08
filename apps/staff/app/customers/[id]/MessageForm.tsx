'use client';

// Message customer (spec Section 2): branch, up to 140 characters, a service-only note.
import { useState } from 'react';
import type { createBrowserSupabaseClient } from '@pixel-barber/shared';
import type { ManageableBranch } from '../../settings/barbers/scope';
import { sendErrorKey } from '../customerLabels';

const MAX_LENGTH = 140;

type Translate = (key: string, values?: Record<string, string | number>) => string;
type Supabase = ReturnType<typeof createBrowserSupabaseClient>;

export function MessageForm({
  supabase,
  customerId,
  branches,
  t,
  onSent,
}: {
  supabase: Supabase;
  customerId: string;
  branches: ManageableBranch[];
  t: Translate;
  onSent: () => void;
}) {
  const [branchId, setBranchId] = useState(branches[0]?.id ?? '');
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setQueued(false);
    if (text.trim() === '') {
      setError(t('emptyMessage'));
      return;
    }
    setSending(true);
    const { error: rpcError } = await supabase.rpc('send_customer_message', {
      p_customer_id: customerId,
      p_branch_id: branchId,
      p_text: text,
    });
    setSending(false);
    if (rpcError) {
      setError(t(sendErrorKey(rpcError.message)));
      return;
    }
    setText('');
    setQueued(true);
    onSent();
  }

  return (
    <section aria-labelledby="customer-message">
      <h2 id="customer-message">{t('messageTitle')}</h2>
      <form onSubmit={send} noValidate>
        {branches.length > 1 && (
          <>
            <label htmlFor="message-branch">{t('messageBranch')}</label>
            <select
              id="message-branch"
              value={branchId}
              onChange={(e) => setBranchId(e.target.value)}
            >
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </>
        )}
        <label htmlFor="message-text">{t('messageLabel')}</label>
        <textarea
          id="message-text"
          maxLength={MAX_LENGTH}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <p>{t('charsLeft', { count: MAX_LENGTH - text.length })}</p>
        <p>{t('serviceNote')}</p>
        <button type="submit" disabled={sending}>
          {t('send')}
        </button>
        {error && <p role="alert">{error}</p>}
        {queued && <p>{t('queued')}</p>}
      </form>
    </section>
  );
}
