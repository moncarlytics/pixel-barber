import { describe, expect, it } from 'vitest';
import { updateTicketWithVersion } from './ticket-updates';

function makeMockClient(updateResult: { data: unknown; error: unknown }) {
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

  it('reports a conflict with no row affected when the version has already moved on', async () => {
    const client = makeMockClient({ data: null, error: null });
    const result = await updateTicketWithVersion(client, 't1', 2, { state: 'cancelled' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.reason).toBe('conflict');
  });

  it('reports a rejected failure with the error when the write itself is rejected (e.g. RLS)', async () => {
    const rlsError = { message: 'new row violates row-level security policy', code: '42501' };
    const client = makeMockClient({ data: null, error: rlsError });
    const result = await updateTicketWithVersion(client, 't1', 2, { state: 'cancelled' });
    expect(result.success).toBe(false);
    if (!result.success && result.reason === 'rejected') expect(result.error).toEqual(rlsError);
  });
});
