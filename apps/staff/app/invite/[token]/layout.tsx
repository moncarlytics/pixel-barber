import type { Metadata } from 'next';

// M6 (final-review fix wave): the invite token lives in this page's URL. Without a `no-referrer`
// policy, following any outbound link from this page (or an image/resource load) would leak the
// token in the Referer header. `referrer: 'no-referrer'` renders a
// `<meta name="referrer" content="no-referrer">` tag scoped to this route segment.
export const metadata: Metadata = {
  referrer: 'no-referrer',
};

export default function InviteTokenLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
