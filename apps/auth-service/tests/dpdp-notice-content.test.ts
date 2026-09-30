import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { NOTICE_HASH_MEMBERS, eighthScheduleLanguage, noticeHash, noticeValidation } from '../src/lib/dpdp-notice.js';

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

describe('the notice hash', () => {
  const notice = {
    noticeId: 'privacy', version: '1.0', language: 'en', title: 'How we use your data', content: 'Text',
    purposes: [{ code: 'orders', description: 'Fulfil orders' }],
    dataFiduciaryContact: null, grievanceOfficer: null,
    itemisedPersonalData: complete.itemisedPersonalData, purposeDetails: complete.purposeDetails,
    withdrawalUrl: complete.withdrawalUrl, rightsUrl: complete.rightsUrl, boardComplaintUrl: complete.boardComplaintUrl,
    contact: { name: 'Data Protection Officer', email: 'dpo@merchant.example' },
  };

  it('is SHA-256 over the RFC 8785 canonical JSON of the listed members', () => {
    const canonical = '{"boardComplaintUrl":"https://merchant.example/privacy/board",'
      + '"contact":{"email":"dpo@merchant.example","name":"Data Protection Officer"},'
      + '"content":"Text","dataFiduciaryContact":null,"grievanceOfficer":null,'
      + '"itemisedPersonalData":[{"category":"contact","description":"Email address"}],'
      + '"language":"en","noticeId":"privacy",'
      + '"purposeDetails":[{"code":"orders","description":"Fulfil orders","goodsOrServices":"Online orders"}],'
      + '"purposes":[{"code":"orders","description":"Fulfil orders"}],'
      + '"rightsUrl":"https://merchant.example/privacy/rights","title":"How we use your data","version":"1.0",'
      + '"withdrawalUrl":"https://merchant.example/consent/withdraw"}';
    expect(noticeHash(notice)).toBe(createHash('sha256').update(canonical, 'utf8').digest('hex'));
    expect([...NOTICE_HASH_MEMBERS].sort()).toEqual(Object.keys(notice).sort());
  });

  it('does not depend on member order, and treats an absent member as null', () => {
    const reordered = Object.fromEntries(Object.entries(notice).reverse()) as typeof notice;
    expect(noticeHash(reordered)).toBe(noticeHash(notice));
    expect(noticeHash({ ...notice, contact: { email: 'dpo@merchant.example', name: 'Data Protection Officer' } }))
      .toBe(noticeHash(notice));
    const { grievanceOfficer: _omitted, ...withoutOfficer } = notice;
    expect(noticeHash(withoutOfficer)).toBe(noticeHash(notice));
  });

  it('changes with every member', () => {
    const base = noticeHash(notice);
    for (const [member, value] of Object.entries({
      noticeId: 'other', version: '1.1', language: 'hi', title: 'Other', content: 'Other text',
      purposes: [], dataFiduciaryContact: 'privacy@merchant.example', grievanceOfficer: { name: 'A', email: 'a@merchant.example' },
      itemisedPersonalData: null, purposeDetails: null, withdrawalUrl: 'https://merchant.example/w',
      rightsUrl: null, boardComplaintUrl: null, contact: null,
    })) {
      expect(noticeHash({ ...notice, [member]: value }), member).not.toBe(base);
    }
  });
});
