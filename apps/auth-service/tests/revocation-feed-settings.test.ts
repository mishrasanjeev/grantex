// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';
import { revocationFeedEnabledFor, revocationFeedSettings } from '../src/lib/revocation-feed/settings.js';

describe('revocation feed settings', () => {
  it('test_feed_enabled_by_default: an unset REVOCATION_FEED_ENABLED serves the feed', () => {
    const settings = revocationFeedSettings({});
    expect(settings.enabled).toBe(true);
    expect(revocationFeedEnabledFor(settings, 'dev_1')).toBe(true);
  });

  it('REVOCATION_FEED_ENABLED=false is the opt-out', () => {
    for (const value of ['false', 'FALSE', ' false ']) {
      const settings = revocationFeedSettings({ REVOCATION_FEED_ENABLED: value });
      expect(settings.enabled).toBe(false);
      expect(revocationFeedEnabledFor(settings, 'dev_1')).toBe(false);
    }
  });

  it('keeps the feed on for any other value, so a typo cannot silently turn it off', () => {
    for (const value of ['true', '', '0', 'no', 'off', 'flase']) {
      expect(revocationFeedSettings({ REVOCATION_FEED_ENABLED: value }).enabled).toBe(true);
    }
  });

  it('still limits the feed to REVOCATION_FEED_DEVELOPER_IDS when it is set', () => {
    const settings = revocationFeedSettings({ REVOCATION_FEED_DEVELOPER_IDS: 'dev_1, dev_2' });
    expect(revocationFeedEnabledFor(settings, 'dev_1')).toBe(true);
    expect(revocationFeedEnabledFor(settings, 'dev_3')).toBe(false);
  });
});
