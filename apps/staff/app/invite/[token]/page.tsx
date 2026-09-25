'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createBrowserSupabaseClient } from '@pixel-barber/shared';
import { postLoginPath } from '../../login/postLoginPath';

const MIN_PASSWORD_LENGTH = 8;

type Preview =
  | { state: 'loading' }
  | { state: 'invalid' }
  | { state: 'valid'; name: string; role: string; branchName: string | null };

async function callAccept(body: Record<string, unknown>) {
  try {
    const response = await fetch(
      `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/staff-invite-accept`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    const parsed = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: response.status, body: parsed };
  } catch {
    return { status: 0, body: {} as Record<string, unknown> };
  }
}

export default function AcceptInvitePage() {
  const t = useTranslations('AcceptInvite');
  const tRoles = useTranslations('StaffRoles');
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const supabase = createBrowserSupabaseClient();
  const [preview, setPreview] = useState<Preview>({ state: 'loading' });
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<'tooShort' | 'mismatch' | 'failed' | 'signInFailed' | null>(
    null,
  );
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    callAccept({ token: params.token, mode: 'preview' }).then(({ status, body }) => {
      if (cancelled) return;
      if (status === 200 && body.valid === true) {
        setPreview({
          state: 'valid',
          name: body.name as string,
          role: body.role as string,
          branchName: (body.branch_name as string | null) ?? null,
        });
      } else {
        setPreview({ state: 'invalid' });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [params.token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError('tooShort');
      return;
    }
    if (password !== confirm) {
      setError('mismatch');
      return;
    }
    setSubmitting(true);
    const { status, body } = await callAccept({ token: params.token, mode: 'accept', password });
    if (status === 410) {
      setSubmitting(false);
      setPreview({ state: 'invalid' });
      return;
    }
    if (status === 400) {
      setSubmitting(false);
      setError('tooShort');
      return;
    }
    if (status !== 200) {
      setSubmitting(false);
      setError('failed');
      return;
    }
    const login = body.login as { email?: string; phone?: string };
    const { data, error: signInError } = await supabase.auth.signInWithPassword(
      login.email ? { email: login.email, password } : { phone: login.phone!, password },
    );
    if (signInError || !data.user) {
      setSubmitting(false);
      setError('signInFailed');
      return;
    }
    router.push(await postLoginPath(supabase, data.user.id));
  }

  if (preview.state === 'loading') {
    return (
      <main>
        <p>{t('loading')}</p>
      </main>
    );
  }
  if (preview.state === 'invalid') {
    return (
      <main>
        <h1>{t('title')}</h1>
        <p role="alert">{t('invalid')}</p>
      </main>
    );
  }

  return (
    <main>
      <h1>{t('title')}</h1>
      <p>{t('invited')}</p>
      <p>{t('nameLine', { name: preview.name })}</p>
      <p>{t('roleLine', { role: tRoles(`role_${preview.role}`) })}</p>
      {preview.branchName && <p>{t('branchLine', { branch: preview.branchName })}</p>}
      {error && (
        <p role="alert">
          {t(error)}
          {error === 'signInFailed' && (
            <>
              {' '}
              <Link href="/login">{t('goToLogin')}</Link>
            </>
          )}
        </p>
      )}
      <form onSubmit={handleSubmit}>
        <label>
          {t('passwordLabel')}
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <label>
          {t('confirmLabel')}
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>
        <button type="submit" disabled={submitting}>
          {t('submit')}
        </button>
      </form>
    </main>
  );
}
