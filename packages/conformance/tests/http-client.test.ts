import { describe, it, expect } from 'vitest';
import {
  parseRetryDelaySeconds,
  MAX_RETRY_DELAY_SEC,
  DEFAULT_RETRY_DELAY_SEC,
} from '../src/http-client.js';

const headers = (init: Record<string, string> = {}): Headers => new Headers(init);

describe('parseRetryDelaySeconds', () => {
  it('reads @fastify/rate-limit\'s default "retry in 1 minute" as 60 seconds, not 1', () => {
    expect(parseRetryDelaySeconds(headers(), 'Rate limit exceeded, retry in 1 minute')).toBe(60);
  });

  it('honours second and minute units in the body', () => {
    expect(parseRetryDelaySeconds(headers(), 'Plan rate limit exceeded, retry in 5 seconds')).toBe(5);
    expect(parseRetryDelaySeconds(headers(), 'retry in 30 secs')).toBe(30);
    expect(parseRetryDelaySeconds(headers(), 'retry in 2 minutes')).toBe(MAX_RETRY_DELAY_SEC);
  });

  it('treats a bare number as seconds', () => {
    expect(parseRetryDelaySeconds(headers(), 'retry in 7')).toBe(7);
  });

  it('prefers a delta-seconds Retry-After header over the body', () => {
    expect(parseRetryDelaySeconds(headers({ 'retry-after': '3' }), 'retry in 1 minute')).toBe(3);
  });

  it('accepts an HTTP-date Retry-After header', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const at = new Date(now + 15_000).toUTCString();
    expect(parseRetryDelaySeconds(headers({ 'Retry-After': at }), '', now)).toBe(15);
  });

  it('clamps a past HTTP-date to 0 and long waits to the cap', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const past = new Date(now - 5_000).toUTCString();
    expect(parseRetryDelaySeconds(headers({ 'retry-after': past }), '', now)).toBe(0);
    expect(parseRetryDelaySeconds(headers({ 'retry-after': '120' }), '')).toBe(MAX_RETRY_DELAY_SEC);
    expect(parseRetryDelaySeconds(headers(), 'retry in 3 hours')).toBe(MAX_RETRY_DELAY_SEC);
  });

  it('falls back to the default when nothing is parseable', () => {
    expect(parseRetryDelaySeconds(headers(), 'Too Many Requests')).toBe(DEFAULT_RETRY_DELAY_SEC);
    expect(parseRetryDelaySeconds(headers({ 'retry-after': 'soon' }), '{}')).toBe(DEFAULT_RETRY_DELAY_SEC);
    expect(parseRetryDelaySeconds(headers(), 'retry in 4 fortnights')).toBe(DEFAULT_RETRY_DELAY_SEC);
  });

  it('accepts a plain header record as well as a Headers object', () => {
    expect(parseRetryDelaySeconds({ 'Retry-After': '4' }, '')).toBe(4);
    expect(parseRetryDelaySeconds({ 'retry-after': '6' }, '')).toBe(6);
    expect(parseRetryDelaySeconds({}, 'retry in 1 minute')).toBe(60);
  });
});
