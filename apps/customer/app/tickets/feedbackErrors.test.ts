// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { feedbackErrorKey } from './feedbackErrors';

describe('feedbackErrorKey', () => {
  it.each([
    ['too_late', 'closed'],
    ['already_submitted', 'thanks'],
    ['invalid_rating', 'generic'],
    ['Failed to fetch', 'generic'],
    [undefined, 'generic'],
  ] as const)('maps %s to %s', (code, key) => {
    expect(feedbackErrorKey(code)).toBe(key);
  });
});
