import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pixel Barber',
  description: 'Join a queue or book an appointment at Pixel Barber.',
  icons: { apple: '/icons/180' },
  appleWebApp: { capable: true, title: 'Pixel Barber', statusBarStyle: 'default' },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
