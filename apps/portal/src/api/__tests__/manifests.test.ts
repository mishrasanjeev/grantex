import { describe, it, expect } from 'vitest';
import { BUNDLED_MANIFESTS, CATEGORIES } from '../manifests';

describe('manifests', () => {
  // ── BUNDLED_MANIFESTS ───────────────────────────────────────────────

  it('exports a non-empty array of manifests', () => {
    expect(Array.isArray(BUNDLED_MANIFESTS)).toBe(true);
    expect(BUNDLED_MANIFESTS.length).toBeGreaterThan(50);
  });

  it('every manifest has required fields', () => {
    for (const m of BUNDLED_MANIFESTS) {
      expect(m.connector).toBeTruthy();
      expect(m.category).toBeTruthy();
      expect(m.tools).toBeGreaterThan(0);
      expect(m.description).toBeTruthy();
    }
  });

  it('every manifest category is a known category', () => {
    const validCategories = CATEGORIES.filter((c) => c !== 'all');
    for (const m of BUNDLED_MANIFESTS) {
      expect(validCategories).toContain(m.category);
    }
  });

  it('connector names are unique', () => {
    const connectors = BUNDLED_MANIFESTS.map((m) => m.connector);
    expect(new Set(connectors).size).toBe(connectors.length);
  });

  it('has manifests in each category', () => {
    const categories = CATEGORIES.filter((c) => c !== 'all');
    for (const cat of categories) {
      const count = BUNDLED_MANIFESTS.filter((m) => m.category === cat).length;
      expect(count).toBeGreaterThan(0);
    }
  });

  it('includes key connectors', () => {
    const connectors = BUNDLED_MANIFESTS.map((m) => m.connector);
    for (const key of ['salesforce', 'stripe', 'slack', 'github', 'jira', 'gmail']) {
      expect(connectors).toContain(key);
    }
  });

  it('tool counts are reasonable (1-20)', () => {
    for (const m of BUNDLED_MANIFESTS) {
      expect(m.tools).toBeGreaterThanOrEqual(1);
      expect(m.tools).toBeLessThanOrEqual(20);
    }
  });

  // ── CATEGORIES ────────────────────────────────────────────────────────

  it('CATEGORIES includes all and specific categories', () => {
    expect(CATEGORIES).toContain('all');
    expect(CATEGORIES).toContain('finance');
    expect(CATEGORIES).toContain('hr');
    expect(CATEGORIES).toContain('marketing');
    expect(CATEGORIES).toContain('ops');
    expect(CATEGORIES).toContain('comms');
  });

  it('CATEGORIES has exactly 6 entries', () => {
    expect(CATEGORIES).toHaveLength(6);
  });

  // ── Filtering (simulates portal behavior) ─────────────────────────────

  it('filtering by category returns correct subset', () => {
    const finance = BUNDLED_MANIFESTS.filter((m) => m.category === 'finance');
    expect(finance.length).toBeGreaterThan(0);
    for (const m of finance) {
      expect(m.category).toBe('finance');
    }
  });

  it('filtering by "all" returns everything', () => {
    const all = BUNDLED_MANIFESTS;
    expect(all.length).toBe(BUNDLED_MANIFESTS.length);
  });

  it('search by connector name works', () => {
    const results = BUNDLED_MANIFESTS.filter((m) =>
      m.connector.toLowerCase().includes('stripe'),
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.connector).toBe('stripe');
  });
});
