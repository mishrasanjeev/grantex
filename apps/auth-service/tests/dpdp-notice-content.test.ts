import { describe, expect, it } from 'vitest';
import { eighthScheduleLanguage, noticeValidation } from '../src/lib/dpdp-notice.js';

const complete = {
  language: 'en',
  itemisedPersonalData: [{ category: 'contact', description: 'Email address' }],
  purposeDetails: [{ code: 'orders', description: 'Fulfil orders', goodsOrServices: 'Online orders' }],
  withdrawalUrl: 'https://merchant.example/consent/withdraw',
  rightsUrl: 'https://merchant.example/privacy/rights',
  boardComplaintUrl: 'https://merchant.example/privacy/board',
};

describe('DPDP Rules 2025 r.3 notice validation', () => {
  it('lists every element present for a complete notice', () => {
    const v = noticeValidation(complete, { enforced: false });
    expect(v).toMatchObject({ enforced: false, complete: true, missing: [] });
    expect(v.present).toEqual([
      'itemisedPersonalData', 'specificPurposes', 'withdrawalMeans', 'rightsMeans', 'boardComplaintMeans', 'language',
    ]);
  });

  it('lists what is missing without the structured fields', () => {
    const v = noticeValidation({ language: 'en' }, { enforced: true });
    expect(v.complete).toBe(false);
    expect(v.missing).toEqual(['itemisedPersonalData', 'specificPurposes', 'withdrawalMeans', 'rightsMeans', 'boardComplaintMeans']);
    expect(noticeValidation({ ...complete, language: 'fr' }, { enforced: false }).missing).toEqual(['language']);
  });

  it('accepts English and the 22 Eighth Schedule languages by ISO 639 code, with or without a region', () => {
    for (const code of [
      'en', 'eng', 'en-IN', 'as', 'bn', 'brx', 'doi', 'gu', 'hi', 'HI-in', 'hin', 'kn', 'ks', 'kok', 'gom', 'mai', 'ml',
      'mni', 'mr', 'ne', 'or', 'ory', 'pa', 'sa', 'sat', 'sat-Olck', 'sd', 'ta', 'te', 'ur', 'urd',
    ]) {
      expect(eighthScheduleLanguage(code), code).not.toBeNull();
    }
    for (const code of ['fr', 'de-DE', 'zh', 'english', '', 'hi_IN', 'x-hi']) {
      expect(eighthScheduleLanguage(code), code).toBeNull();
    }
    expect(eighthScheduleLanguage('sat')).toBe('Santali');
  });
});
