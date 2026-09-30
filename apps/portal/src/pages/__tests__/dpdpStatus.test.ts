import { describe, it, expect } from 'vitest';
import { consentStatusVariant, grievanceStatusVariant, grievanceStatusLabel } from '../dpdp/status';

describe('DPDP status badges', () => {
  it('maps every consent record status the server produces', () => {
    expect(consentStatusVariant('active')).toBe('success');
    expect(consentStatusVariant('withdrawn')).toBe('warning');
    expect(consentStatusVariant('expired')).toBe('default');
    expect(consentStatusVariant('erased')).toBe('danger');
  });

  it('maps every grievance status the server produces', () => {
    expect(grievanceStatusVariant('submitted')).toBe('warning');
    expect(grievanceStatusVariant('in_review')).toBe('info');
    expect(grievanceStatusVariant('resolved')).toBe('success');
    expect(grievanceStatusVariant('rejected')).toBe('danger');
  });

  it('labels in_review readably', () => {
    expect(grievanceStatusLabel('in_review')).toBe('in review');
    expect(grievanceStatusLabel('resolved')).toBe('resolved');
  });
});
