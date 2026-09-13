'use client';

import Link from 'next/link';
import { useTranslations } from 'next-intl';

export default function Home() {
  const t = useTranslations('Home');
  return (
    <main>
      <h1>{t('title')}</h1>
      <Link href="/login">{t('logIn')}</Link>
    </main>
  );
}
