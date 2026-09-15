/**
 * Consent page theme. Values are validated when the server is created: a
 * colour must be a hex colour, and text/background pairs must meet WCAG 2.1
 * AA contrast (4.5:1), so a theme cannot make the page unreadable or break
 * out of the stylesheet.
 */

export interface ConsentTheme {
  /** Page background. */
  backgroundColor?: string;
  /** Card background. */
  surfaceColor?: string;
  /** Body text. */
  textColor?: string;
  /** Secondary text. */
  mutedTextColor?: string;
  /** Primary button background, links and focus ring. */
  accentColor?: string;
  /** Text on the primary button. */
  accentTextColor?: string;
  /** Borders and dividers. */
  borderColor?: string;
  /** Corner radius in px (0-24). */
  radiusPx?: number;
  /** CSS font-family list, e.g. `Inter, system-ui, sans-serif` (letters, digits, spaces, commas, hyphens). */
  fontFamily?: string;
}

export type ResolvedTheme = Required<ConsentTheme>;

export const DEFAULT_THEME: ResolvedTheme = {
  backgroundColor: '#f4f5f7',
  surfaceColor: '#ffffff',
  textColor: '#1b1f24',
  mutedTextColor: '#4b5563',
  accentColor: '#1d4ed8',
  accentTextColor: '#ffffff',
  borderColor: '#9aa3af',
  radiusPx: 8,
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, Helvetica Neue, Arial, sans-serif',
};

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
// Letters, digits, spaces, commas and hyphens only: unquoted family names
// (`Segoe UI`, `Helvetica Neue`) are valid CSS, and nothing here can end a
// declaration or a rule.
const FONT_FAMILY = /^[A-Za-z0-9 ,-]{1,200}$/;

function channel(hex: string, index: number): number {
  const full = hex.length === 4 ? hex.slice(1).split('').map((c) => c + c).join('') : hex.slice(1);
  const value = parseInt(full.slice(index * 2, index * 2 + 2), 16) / 255;
  return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  return 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
}

/** WCAG 2.1 contrast ratio between two hex colours. */
export function contrastRatio(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

export function resolveTheme(theme: ConsentTheme | undefined): ResolvedTheme {
  const resolved: ResolvedTheme = { ...DEFAULT_THEME, ...(theme ?? {}) };
  for (const key of ['backgroundColor', 'surfaceColor', 'textColor', 'mutedTextColor', 'accentColor', 'accentTextColor', 'borderColor'] as const) {
    if (typeof resolved[key] !== 'string' || !HEX.test(resolved[key])) {
      throw new Error(`consentPage.theme.${key} must be a hex colour such as #1d4ed8`);
    }
  }
  if (!Number.isInteger(resolved.radiusPx) || resolved.radiusPx < 0 || resolved.radiusPx > 24) {
    throw new Error('consentPage.theme.radiusPx must be an integer from 0 to 24');
  }
  if (typeof resolved.fontFamily !== 'string' || !FONT_FAMILY.test(resolved.fontFamily)) {
    throw new Error('consentPage.theme.fontFamily may contain only letters, digits, spaces, commas and hyphens');
  }
  const pairs: Array<[keyof ResolvedTheme, keyof ResolvedTheme]> = [
    ['textColor', 'surfaceColor'],
    ['textColor', 'backgroundColor'],
    ['mutedTextColor', 'surfaceColor'],
    ['accentColor', 'surfaceColor'],
    ['accentTextColor', 'accentColor'],
  ];
  for (const [fg, bg] of pairs) {
    const ratio = contrastRatio(resolved[fg] as string, resolved[bg] as string);
    if (ratio < 4.5) {
      throw new Error(
        `consentPage.theme: ${fg} on ${bg} has contrast ${ratio.toFixed(2)}:1; WCAG 2.1 AA needs at least 4.5:1`,
      );
    }
  }
  return resolved;
}

/** The page stylesheet. Mobile first; no external resources. */
export function stylesheet(theme: ResolvedTheme): string {
  return `
:root{--bg:${theme.backgroundColor};--surface:${theme.surfaceColor};--text:${theme.textColor};--muted:${theme.mutedTextColor};--accent:${theme.accentColor};--on-accent:${theme.accentTextColor};--border:${theme.borderColor};--radius:${theme.radiusPx}px}
*,*::before,*::after{box-sizing:border-box}
html{-webkit-text-size-adjust:100%;text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font-family:${theme.fontFamily};font-size:1rem;line-height:1.5}
main{max-width:40rem;margin:0 auto;padding:1rem}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:1.25rem}
header.brand{display:flex;align-items:center;gap:.75rem;margin-bottom:1rem}
header.brand img{width:2.5rem;height:2.5rem;border-radius:var(--radius);object-fit:contain}
h1{font-size:1.375rem;line-height:1.3;margin:0 0 .5rem}
h2{font-size:1rem;margin:1.25rem 0 .5rem}
p{margin:0 0 .75rem}
.muted{color:var(--muted)}
.id{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.875rem}
.wrap{overflow-wrap:anywhere;word-break:break-word}
dl{margin:0;display:grid;grid-template-columns:1fr;gap:.25rem .75rem}
dt{font-weight:600}
dd{margin:0 0 .5rem}
@media (min-width:30rem){dl{grid-template-columns:minmax(7rem,max-content) 1fr}dd{margin:0}}
ul.tools{list-style:none;margin:0;padding:0;display:grid;gap:.5rem}
ul.tools li{border:1px solid var(--border);border-radius:var(--radius);padding:.625rem .75rem}
.tool-name{font-weight:600}
.tag{display:inline-block;border:1px solid var(--border);border-radius:999px;padding:0 .5rem;font-size:.8125rem;margin:.25rem .25rem 0 0}
.notice{border-left:4px solid var(--text);background:var(--bg);padding:.625rem .75rem;margin:.75rem 0;border-radius:var(--radius)}
.redirect{font-size:1.125rem;font-weight:700}
form.actions{display:flex;flex-direction:column;gap:.75rem;margin-top:1.25rem}
@media (min-width:30rem){form.actions{flex-direction:row-reverse;justify-content:flex-start}}
button{font:inherit;font-weight:600;min-height:2.75rem;min-width:2.75rem;padding:.625rem 1.25rem;border-radius:var(--radius);cursor:pointer;border:2px solid var(--accent)}
button.approve{background:var(--accent);color:var(--on-accent)}
button.deny{background:var(--surface);color:var(--text);border-color:var(--text)}
button:focus-visible,a:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
a{color:var(--accent)}
footer{margin-top:1rem;font-size:.875rem}
footer a{display:inline-block;min-height:1.5rem;margin-right:1rem}
`.trim();
}
