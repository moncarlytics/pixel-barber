/**
 * Where to send a customer after logging in: the `next` path they were heading to, but only a
 * same-site path (never another site, never the login page itself) -- otherwise Home.
 */
export function safeNextPath(next: string | null): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/';
  if (next === '/login' || next.startsWith('/login?') || next.startsWith('/login/')) return '/';
  return next;
}

/** The login URL for a page that needs a signed-in customer, explaining the session ended. */
export function sessionEndedLoginPath(currentPath: string): string {
  return `/login?next=${encodeURIComponent(currentPath)}&reason=session`;
}
