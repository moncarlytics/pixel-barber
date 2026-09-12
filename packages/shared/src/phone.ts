// PRD section 9.2: phone is validated and normalized to E.164 (+233) before Supabase Auth
// ever sees it. Ghana mobile numbers are 10 digits starting with 0 in local format.
export function normalizeGhanaPhone(input: string): string | null {
  const digitsOnly = input.replace(/[\s-]/g, '');

  if (/^\+233\d{9}$/.test(digitsOnly)) {
    return digitsOnly;
  }
  if (/^0\d{9}$/.test(digitsOnly)) {
    return `+233${digitsOnly.slice(1)}`;
  }
  return null;
}
