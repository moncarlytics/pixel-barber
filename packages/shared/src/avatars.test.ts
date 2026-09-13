import { describe, expect, it } from 'vitest';
import { AVATAR_LIBRARY } from './avatars';

describe('AVATAR_LIBRARY', () => {
  it('has at least 6 distinct avatars', () => {
    expect(AVATAR_LIBRARY.length).toBeGreaterThanOrEqual(6);
  });

  it('has a unique key for every avatar', () => {
    const keys = AVATAR_LIBRARY.map((a) => a.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every avatar has a non-empty emoji and label', () => {
    for (const avatar of AVATAR_LIBRARY) {
      expect(avatar.emoji.length).toBeGreaterThan(0);
      expect(avatar.label.length).toBeGreaterThan(0);
    }
  });
});
