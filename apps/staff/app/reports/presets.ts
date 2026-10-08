// Report date presets (Ghana dates, YYYY-MM-DD). "Last 7 days" includes today.
export type Preset = 'last7' | 'last30' | 'thisMonth' | 'lastMonth' | 'custom';

const DAY_MS = 24 * 60 * 60 * 1000;

function shift(day: string, delta: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + delta * DAY_MS).toISOString().slice(0, 10);
}

export function presetRange(
  preset: Exclude<Preset, 'custom'>,
  today: string,
): { from: string; to: string } {
  const firstOfMonth = `${today.slice(0, 7)}-01`;
  switch (preset) {
    case 'last7':
      return { from: shift(today, -6), to: today };
    case 'last30':
      return { from: shift(today, -29), to: today };
    case 'thisMonth':
      return { from: firstOfMonth, to: today };
    case 'lastMonth': {
      const lastOfPrevious = shift(firstOfMonth, -1);
      return { from: `${lastOfPrevious.slice(0, 7)}-01`, to: lastOfPrevious };
    }
  }
}
