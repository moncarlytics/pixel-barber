import { describe, expect, it, vi } from 'vitest';
import { updateTicketWithVersion } from './ticket-updates';

function makeMockClient(
  updateResult: { data: unknown; error: unknown },
  refetchResult?: { data: unknown },
) {
  return {
    from: () => ({
      update: () => ({
        eq: () => ({
          eq: () => ({
            select: () => ({
              maybeSingle: async () => updateResult,
            }),
          }),
        }),
      }),
    }),
  } as any;
}

describe('updateTicketWithVersion', () => {
  it('succeeds and returns the updated row when the version matches', async () => {
    const client = makeMockClient({
      data: { id: 't1', version: 3, state: 'cancelled' },
      error: null,
    });
    const result = await updateTicketWithVersion(client, 't1', 2, { state: 'cancelled' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.ticket.version).toBe(3);
  });

  it('reports failure with no row affected when the version has already moved on', async () => {
    const client = makeMockClient({ data: null, error: null });
    const result = await updateTicketWithVersion(client, 't1', 2, { state: 'cancelled' });
    expect(result.success).toBe(false);
  });
});
