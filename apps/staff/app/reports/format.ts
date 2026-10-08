// Display formatting shared by the Today dashboard, Reports page and PDF export
// (Docs/superpowers/specs/2026-10-08-reports-dashboard-design.md). Ghana time is UTC.
export const EMPTY = '—';

type Num = number | null | undefined;

export const formatMinutes = (v: Num) => (v == null ? EMPTY : `${v} min`);

export const formatMoney = (v: Num) =>
  v == null
    ? EMPTY
    : `GHS ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const formatPercent = (v: Num) => (v == null ? EMPTY : `${Number(v).toFixed(1)}%`);

export const formatRating = (v: Num) => (v == null ? EMPTY : Number(v).toFixed(2));

export const formatCount = (v: Num) => (v == null ? EMPTY : String(v));

export const formatHour = (h: number) => `${String(h).padStart(2, '0')}:00`;

// Fixed three-letter names: newer ICU data renders September as "Sept" in en-GB.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const formatDay = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
