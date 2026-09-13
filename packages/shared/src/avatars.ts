// Placeholder avatar library ahead of real design work (Phase 9) -- a fixed set of emoji-based
// markers, not user-uploaded images. `key` is what's stored in customers.avatar_key; `emoji`/
// `label` are purely presentational and can be swapped for real artwork later with zero schema
// or data migration, since the stored value is an opaque key, not a file path.
export interface Avatar {
  key: string;
  emoji: string;
  label: string;
}

export const AVATAR_LIBRARY: readonly Avatar[] = [
  { key: 'clipper', emoji: '💈', label: 'Barber Pole' },
  { key: 'scissors', emoji: '✂️', label: 'Scissors' },
  { key: 'star', emoji: '⭐', label: 'Star' },
  { key: 'fire', emoji: '🔥', label: 'Fire' },
  { key: 'crown', emoji: '👑', label: 'Crown' },
  { key: 'lightning', emoji: '⚡', label: 'Lightning' },
  { key: 'diamond', emoji: '💎', label: 'Diamond' },
  { key: 'rocket', emoji: '🚀', label: 'Rocket' },
];
