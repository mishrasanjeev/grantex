/**
 * Minimal auto-escaping HTML templating for the consent page. Every value
 * interpolated into `html` is escaped unless it is itself a {@link SafeHtml}
 * produced by `html`; arrays are joined. `html` must be used as a template
 * tag: calling it as a function with an ordinary array is refused, so
 * request data cannot be passed in as template text. (A caller that builds
 * a frozen array with a frozen `raw` property can still forge one; that is
 * code in the host application, not request data.)
 */

const SAFE = Symbol('grantex.safeHtml');

export interface SafeHtml {
  readonly [SAFE]: true;
  readonly value: string;
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === 'object' && value !== null && (value as Partial<SafeHtml>)[SAFE] === true;
}

function safe(value: string): SafeHtml {
  return { [SAFE]: true, value };
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
  '`': '&#96;',
};

/** Escapes text for use in HTML element content and quoted attribute values. */
export function escapeHtml(value: unknown): string {
  return String(value).replace(/[&<>"'`]/g, (c) => ESCAPES[c]!);
}

function fragment(value: unknown): string {
  if (value === undefined || value === null || value === false) return '';
  if (Array.isArray(value)) return value.map(fragment).join('');
  if (isSafeHtml(value)) return value.value;
  return escapeHtml(value);
}

/** Tagged template: `html\`<p>${untrusted}</p>\`` escapes `untrusted`. */
export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  // A real template strings array is frozen and carries a frozen `raw` copy.
  const raw = (strings as { raw?: unknown }).raw;
  if (!Array.isArray(strings) || !Object.isFrozen(strings) || !Array.isArray(raw) || !Object.isFrozen(raw)
    || raw.length !== strings.length || values.length !== strings.length - 1) {
    throw new TypeError('html must be used as a template literal tag: html`...`');
  }
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    out += fragment(values[i]) + (strings[i + 1] ?? '');
  }
  return safe(out);
}

/** For package-internal constants only (the stylesheet); never for request data. */
export function trustedConstant(value: string): SafeHtml {
  return safe(value);
}
