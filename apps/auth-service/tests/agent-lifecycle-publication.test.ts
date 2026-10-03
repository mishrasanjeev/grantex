import { describe, expect, it, vi } from 'vitest';
import * as events from '../src/lib/events.js';
import { publishLifecycleGrantRevocations } from '../src/lib/revoke.js';

describe('lifecycle grant revocation publication', () => {
  it('publishes one grant-id event per committed row and marks affected parents', async () => {
    const emit = vi.spyOn(events, 'emitEvent').mockResolvedValue(undefined);
    try {
      const expiresAt = new Date(Date.now() + 60_000);
      const rows = [
        { id: 'grnt_parent', expires_at: expiresAt, parent_grant_id: null },
        { id: 'grnt_child', expires_at: expiresAt, parent_grant_id: 'grnt_parent' },
      ];
      expect(emit).not.toHaveBeenCalled();
      expect(await publishLifecycleGrantRevocations('dev_lifecycle', rows))
        .toEqual(['grnt_parent', 'grnt_child']);
      expect(emit).toHaveBeenCalledTimes(2);
      expect(emit).toHaveBeenCalledWith('dev_lifecycle', 'grant.revoked', {
        grantId: 'grnt_parent', cascade: true,
      });
      expect(emit).toHaveBeenCalledWith('dev_lifecycle', 'grant.revoked', {
        grantId: 'grnt_child', cascade: false,
      });
      emit.mockClear();
      expect(await publishLifecycleGrantRevocations('dev_lifecycle', [])).toEqual([]);
      expect(emit).not.toHaveBeenCalled();
    } finally {
      emit.mockRestore();
    }
  });

  it('waits for event enqueue before returning without undoing committed revocation', async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const emit = vi.spyOn(events, 'emitEvent').mockImplementation(() => pending);
    try {
      const rows = [{
        id: 'grnt_one', expires_at: new Date(Date.now() + 60_000), parent_grant_id: null,
      }];
      let returned = false;
      const publication = publishLifecycleGrantRevocations('dev_lifecycle', rows).then(() => {
        returned = true;
      });
      await vi.waitFor(() => expect(emit).toHaveBeenCalledTimes(1));
      expect(returned).toBe(false);
      finish();
      await publication;
      expect(returned).toBe(true);
    } finally {
      finish?.();
      emit.mockRestore();
    }
  });
});
