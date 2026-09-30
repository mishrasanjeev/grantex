/**
 * What a DPDP consent notice contains, checked against DPDP Rules 2025 r.3.
 *
 * r.3 asks that a notice (DPDP Act s.5) be understandable on its own and give
 * an itemised description of the personal data, the specific purposes and
 * the goods, services or uses they enable, and a link and means to withdraw
 * consent, to exercise the principal's rights and to complain to the Data
 * Protection Board, in English or a language of the Eighth Schedule to the
 * Constitution. Only the presence of these elements can be checked here, not
 * whether the text is clear: the check is evidence for the fiduciary's own
 * review, not a verdict.
 */

/**
 * English and the 22 languages of the Eighth Schedule, keyed by ISO 639 code:
 * the 639-1 code where one exists, and the 639-2/639-3 codes as well.
 * Konkani is listed under both kok (macrolanguage) and gom (Goan Konkani);
 * Odia under or, ori and ory.
 */
const LANGUAGES: Record<string, string> = {
  en: 'English', eng: 'English',
  as: 'Assamese', asm: 'Assamese',
  bn: 'Bengali', ben: 'Bengali',
  brx: 'Bodo',
  doi: 'Dogri',
  gu: 'Gujarati', guj: 'Gujarati',
  hi: 'Hindi', hin: 'Hindi',
  kn: 'Kannada', kan: 'Kannada',
  ks: 'Kashmiri', kas: 'Kashmiri',
  kok: 'Konkani', gom: 'Konkani',
  mai: 'Maithili',
  ml: 'Malayalam', mal: 'Malayalam',
  mni: 'Manipuri',
  mr: 'Marathi', mar: 'Marathi',
  ne: 'Nepali', nep: 'Nepali',
  or: 'Odia', ori: 'Odia', ory: 'Odia',
  pa: 'Punjabi', pan: 'Punjabi',
  sa: 'Sanskrit', san: 'Sanskrit',
  sat: 'Santali',
  sd: 'Sindhi', snd: 'Sindhi',
  ta: 'Tamil', tam: 'Tamil',
  te: 'Telugu', tel: 'Telugu',
  ur: 'Urdu', urd: 'Urdu',
};

/** A BCP 47 tag: a 2- or 3-letter primary language subtag and optional subtags. */
const LANGUAGE_TAG = /^([a-zA-Z]{2,3})(-[a-zA-Z0-9]{1,8})*$/;

/**
 * The language's English name when `tag` is English or an Eighth Schedule
 * language (by its primary subtag, so `hi-IN` is Hindi), otherwise null.
 */
export function eighthScheduleLanguage(tag: string): string | null {
  const match = LANGUAGE_TAG.exec(tag);
  if (!match) return null;
  return LANGUAGES[match[1]!.toLowerCase()] ?? null;
}

export const RULE3_ELEMENTS = [
  'itemisedPersonalData',
  'specificPurposes',
  'withdrawalMeans',
  'rightsMeans',
  'boardComplaintMeans',
  'language',
] as const;
export type Rule3Element = (typeof RULE3_ELEMENTS)[number];

export interface NoticeContent {
  language: string;
  itemisedPersonalData?: unknown[] | null;
  purposeDetails?: unknown[] | null;
  withdrawalUrl?: string | null;
  rightsUrl?: string | null;
  boardComplaintUrl?: string | null;
}

export interface NoticeValidation {
  basis: 'DPDP Rules 2025 r.3';
  /** Whether DPDP_NOTICE_REQUIRE_RULE3 refused notices missing an element. */
  enforced: boolean;
  complete: boolean;
  present: Rule3Element[];
  missing: Rule3Element[];
  language: { tag: string; name: string | null; englishOrEighthSchedule: boolean };
}

export function noticeValidation(notice: NoticeContent, options: { enforced: boolean }): NoticeValidation {
  const name = eighthScheduleLanguage(notice.language);
  const has: Record<Rule3Element, boolean> = {
    itemisedPersonalData: Array.isArray(notice.itemisedPersonalData) && notice.itemisedPersonalData.length > 0,
    specificPurposes: Array.isArray(notice.purposeDetails) && notice.purposeDetails.length > 0,
    withdrawalMeans: Boolean(notice.withdrawalUrl),
    rightsMeans: Boolean(notice.rightsUrl),
    boardComplaintMeans: Boolean(notice.boardComplaintUrl),
    language: name !== null,
  };
  const present = RULE3_ELEMENTS.filter((element) => has[element]);
  const missing = RULE3_ELEMENTS.filter((element) => !has[element]);
  return {
    basis: 'DPDP Rules 2025 r.3',
    enforced: options.enforced,
    complete: missing.length === 0,
    present,
    missing,
    language: { tag: notice.language, name, englishOrEighthSchedule: name !== null },
  };
}
