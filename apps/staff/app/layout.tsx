import type { Metadata } from 'next';
import { NextIntlClientProvider } from 'next-intl';
import { StaffHeader } from './StaffHeader';
import './globals.css';

export const metadata: Metadata = {
  title: 'Pixel Barber — Staff Portal',
  description: 'Branch and business operations for Pixel Barber staff.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <NextIntlClientProvider>
          <StaffHeader />
          {children}
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
