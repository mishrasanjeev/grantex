import { createHash } from 'node:crypto';
import { escapeHtml, html, isSafeHtml, trustedConstant } from './html.js';
import type { SafeHtml } from './html.js';
import { resolveTheme, stylesheet } from './theme.js';
import type { ConsentTheme, ResolvedTheme } from './theme.js';
import type { ToolPolicy } from '../resource/tool-policy.js';
import { isLoopbackHost } from '../lib/resource.js';

/** Everything the consent page shows. All strings are untrusted and escaped on output. */
export interface ConsentViewModel {
  appName: string;
  logoUrl?: string;
  privacyUrl?: string;
  termsUrl?: string;
  client: {
    id: string;
    name: string;
    /** True when the client identified itself with a metadata document URL. */
    metadataDocument: boolean;
  };
  redirect: {
    uri: string;
    /** Host (and port) the Principal is sent back to, shown prominently. */
    host: string;
    /** Every redirect URI the client registered is on this machine (localhost). */
    loopbackOnly: boolean;
  };
  resource: { uri: string; name?: string };
  scopes: string[];
  purpose?: { code: string; description?: string };
  dataRegion?: string;
  /** Human-readable grant lifetime, e.g. "8 hours". */
  duration?: string;
  tools: Array<{
    name: string;
    connector?: string;
    permission?: string;
    caps: Array<{ label: string; value: string }>;
    allowedPurposes?: string[];
    requiresDecision: boolean;
  }>;
  consentId: string;
  csrfToken: string;
  formAction: string;
}

export interface ConsentText {
  title: string;
  intro: string;
  redirectHeading: string;
  localhostWarning: string;
  metadataDocumentNote: string;
  detailsHeading: string;
  purposeLabel: string;
  noPurpose: string;
  regionLabel: string;
  noRegion: string;
  durationLabel: string;
  noDuration: string;
  resourceLabel: string;
  toolsHeading: string;
  noTools: string;
  decisionNote: string;
  scopesHeading: string;
  approve: string;
  deny: string;
  nextStepNote: string;
  privacy: string;
  terms: string;
}

export const DEFAULT_TEXT: ConsentText = {
  title: 'Allow access?',
  intro: 'wants to act on your behalf with the tools below.',
  redirectHeading: 'After you decide, you will be sent to',
  localhostWarning: 'This application runs on your own device (localhost). Only continue if you started this sign-in yourself.',
  metadataDocumentNote: 'This application identified itself with a published metadata document; its name was not verified by this server.',
  detailsHeading: 'What you are granting',
  purposeLabel: 'Purpose',
  noPurpose: 'No purpose declared',
  regionLabel: 'Data region',
  noRegion: 'Not restricted',
  durationLabel: 'Duration',
  noDuration: 'Set by the authorization server',
  resourceLabel: 'Service',
  toolsHeading: 'Tools',
  noTools: 'No tools are covered by the requested permissions.',
  decisionNote: 'Needs a person to approve each action',
  scopesHeading: 'Permissions requested',
  approve: 'Allow',
  deny: 'Deny',
  nextStepNote: 'If you allow, you may be asked to confirm again with Grantex.',
  privacy: 'Privacy policy',
  terms: 'Terms',
};

export interface ConsentRenderHelpers {
  /** Auto-escaping template tag. Return its result from `renderDetails`. */
  html: typeof html;
  escapeHtml: typeof escapeHtml;
  text: ConsentText;
}

export interface ConsentPageOptions {
  /** Colours, radius and font. Validated for WCAG AA contrast at start-up. */
  theme?: ConsentTheme;
  /** Replace any of the page's strings (for wording or translation). */
  text?: Partial<ConsentText>;
  /** `lang` attribute of the page (default `en`). */
  lang?: string;
  /**
   * Replaces the "What you are granting" section. Must return the result of
   * `helpers.html`, so every interpolated value is escaped. The header
   * (application, redirect host, warnings) and the form are always rendered
   * by the package and cannot be removed.
   */
  renderDetails?: (model: ConsentViewModel, helpers: ConsentRenderHelpers) => SafeHtml;
  /** Extra CSS appended to the stylesheet (covered by the CSP hash). Must not contain `</style`. */
  extraCss?: string;
  /** How long a rendered page can be submitted, in seconds (default 600). */
  expiresInSeconds?: number;
}

export interface PreparedConsentPage {
  theme: ResolvedTheme;
  text: ConsentText;
  lang: string;
  css: string;
  styleHash: string;
  options: ConsentPageOptions;
}

const LANG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

/** Validates options once at start-up. */
export function prepareConsentPage(options: ConsentPageOptions = {}): PreparedConsentPage {
  const theme = resolveTheme(options.theme);
  const text = { ...DEFAULT_TEXT, ...(options.text ?? {}) };
  for (const [key, value] of Object.entries(text)) {
    if (typeof value !== 'string') throw new Error(`consentPage.text.${key} must be a string`);
  }
  const lang = options.lang ?? 'en';
  if (!LANG.test(lang)) throw new Error('consentPage.lang must be a BCP 47 language tag');
  if (options.extraCss !== undefined && (typeof options.extraCss !== 'string' || /<\/?style|<!--/i.test(options.extraCss))) {
    throw new Error('consentPage.extraCss must be a string without <style> or HTML comment markup');
  }
  if (options.renderDetails !== undefined && typeof options.renderDetails !== 'function') {
    throw new Error('consentPage.renderDetails must be a function');
  }
  const css = `${stylesheet(theme)}\n${options.extraCss ?? ''}`.trim();
  const styleHash = createHash('sha256').update(css, 'utf8').digest('base64');
  return { theme, text, lang, css, styleHash, options };
}

const UNITS: Record<string, [string, string]> = { s: ['second', 'seconds'], m: ['minute', 'minutes'], h: ['hour', 'hours'], d: ['day', 'days'] };

/** `8h` → `8 hours`. Returns undefined for anything that is not `<n><s|m|h|d>`. */
export function humanDuration(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const match = /^(\d{1,6})([smhd])$/.exec(value);
  if (!match) return undefined;
  const count = Number(match[1]);
  const [one, many] = UNITS[match[2]!]!;
  return `${count} ${count === 1 ? one : many}`;
}

function capLabel(key: string): string {
  return ({ per_hour: 'per hour', per_day: 'per day', per_case: 'per case' } as Record<string, string>)[key] ?? key;
}

/** Tools the requested scopes would cover, with their caps, for display. */
export function toolsForScopes(policy: ToolPolicy | undefined, scopes: readonly string[]): ConsentViewModel['tools'] {
  if (!policy) return [];
  return policy.tools
    .filter((requirement) => policy.isSatisfied(requirement, scopes))
    .map((requirement) => ({
      name: requirement.name,
      ...(requirement.connector !== undefined ? { connector: requirement.connector } : {}),
      ...(requirement.permission !== undefined ? { permission: requirement.permission } : {}),
      caps: Object.entries(requirement.caps ?? {})
        .filter(([, value]) => typeof value === 'number')
        .map(([key, value]) => ({ label: capLabel(key), value: value === 0 ? 'disabled' : `at most ${value} calls` })),
      ...(requirement.allowedPurposes !== undefined ? { allowedPurposes: requirement.allowedPurposes } : {}),
      requiresDecision: requirement.requiresDecision,
    }));
}

function defaultDetails(model: ConsentViewModel, { text }: ConsentRenderHelpers): SafeHtml {
  return html`
    <section aria-labelledby="details-heading">
      <h2 id="details-heading">${text.detailsHeading}</h2>
      <dl>
        <dt>${text.purposeLabel}</dt>
        <dd>${model.purpose
          ? html`<span class="id">${model.purpose.code}</span>${model.purpose.description ? html`<br><span class="muted">${model.purpose.description}</span>` : ''}`
          : text.noPurpose}</dd>
        <dt>${text.regionLabel}</dt>
        <dd>${model.dataRegion ?? text.noRegion}</dd>
        <dt>${text.durationLabel}</dt>
        <dd>${model.duration ?? text.noDuration}</dd>
        <dt>${text.resourceLabel}</dt>
        <dd class="wrap">${model.resource.name ? html`${model.resource.name}<br>` : ''}<span class="id muted">${model.resource.uri}</span></dd>
      </dl>
      <h2 id="tools-heading">${text.toolsHeading}</h2>
      ${model.tools.length === 0
        ? html`<p class="muted">${text.noTools}</p>`
        : html`<ul class="tools" aria-labelledby="tools-heading">${model.tools.map((tool) => html`
          <li>
            <span class="tool-name wrap">${tool.name}</span>
            ${tool.connector ? html` <span class="muted">(${tool.connector})</span>` : ''}
            <div>
              ${tool.permission ? html`<span class="tag">${tool.permission}</span>` : ''}
              ${tool.caps.map((cap) => html`<span class="tag">${cap.label}: ${cap.value}</span>`)}
              ${tool.requiresDecision ? html`<span class="tag">${text.decisionNote}</span>` : ''}
            </div>
          </li>`)}</ul>`}
      <h2 id="scopes-heading">${text.scopesHeading}</h2>
      <ul aria-labelledby="scopes-heading">${model.scopes.map((scope) => html`<li class="id wrap">${scope}</li>`)}</ul>
    </section>`;
}

/** Renders the full consent document. */
export function renderConsentPage(prepared: PreparedConsentPage, model: ConsentViewModel): string {
  const { text, options } = prepared;
  const helpers: ConsentRenderHelpers = { html, escapeHtml, text };
  const details = options.renderDetails ? options.renderDetails(model, helpers) : defaultDetails(model, helpers);
  if (!isSafeHtml(details)) {
    throw new Error('consentPage.renderDetails must return helpers.html`...` so values are escaped');
  }
  const body = html`
<main>
  <div class="card">
    <header class="brand">
      ${model.logoUrl ? html`<img src="${model.logoUrl}" alt="" width="40" height="40">` : ''}
      <p class="muted">${model.appName}</p>
    </header>
    <h1>${text.title}</h1>
    <p><strong class="wrap">${model.client.name}</strong> ${text.intro}</p>
    <p class="muted id wrap">${model.client.id}</p>
    ${model.client.metadataDocument ? html`<p class="notice">${text.metadataDocumentNote}</p>` : ''}
    <section aria-labelledby="redirect-heading">
      <h2 id="redirect-heading">${text.redirectHeading}</h2>
      <p class="redirect wrap">${model.redirect.host}</p>
      <p class="muted id wrap">${model.redirect.uri}</p>
      ${model.redirect.loopbackOnly ? html`<p class="notice" role="note">${text.localhostWarning}</p>` : ''}
    </section>
    ${details}
    <form class="actions" method="post" action="${model.formAction}">
      <input type="hidden" name="consent_id" value="${model.consentId}">
      <input type="hidden" name="csrf_token" value="${model.csrfToken}">
      <button class="approve" type="submit" name="decision" value="approve">${text.approve}</button>
      <button class="deny" type="submit" name="decision" value="deny">${text.deny}</button>
    </form>
    <p class="muted">${text.nextStepNote}</p>
  </div>
  ${model.privacyUrl || model.termsUrl ? html`<footer>
    ${model.privacyUrl ? html`<a href="${model.privacyUrl}" rel="noopener noreferrer">${text.privacy}</a>` : ''}
    ${model.termsUrl ? html`<a href="${model.termsUrl}" rel="noopener noreferrer">${text.terms}</a>` : ''}
  </footer>` : ''}
</main>`;
  return html`<!doctype html>
<html lang="${prepared.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${text.title} · ${model.appName}</title>
<style>${trustedConstant(prepared.css)}</style>
</head>
<body>${body}</body>
</html>`.value;
}

/**
 * Response headers for the page: a strict CSP (no script at all, the
 * stylesheet pinned by hash, images only from the logo's origin, no framing),
 * no-store, and a same-origin referrer policy (the form POST keeps its
 * Origin header; nothing leaks to the client or upstream).
 */
export function consentPageHeaders(prepared: PreparedConsentPage, model: ConsentViewModel, issuerOrigin: string): Record<string, string> {
  const formTargets = new Set<string>(["'self'", 'https:']);
  const redirect = new URL(model.redirect.uri);
  // Browsers apply form-action to the redirects that follow a submission, so
  // a loopback http redirect URI (native apps) must be allowed explicitly.
  if (redirect.protocol === 'http:' && isLoopbackHost(redirect.hostname)) formTargets.add(redirect.origin);
  if (issuerOrigin.startsWith('http:')) formTargets.add(issuerOrigin);
  const imageSources = model.logoUrl ? new URL(model.logoUrl).origin : "'none'";
  const csp = [
    "default-src 'none'",
    "script-src 'none'",
    `style-src 'sha256-${prepared.styleHash}'`,
    `img-src ${imageSources}`,
    `form-action ${[...formTargets].join(' ')}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join('; ');
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': csp,
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
    'cache-control': 'no-store',
    'cross-origin-opener-policy': 'same-origin',
  };
}

/** A minimal page for refusals and expiry, with the same stylesheet and headers. */
export function renderMessagePage(prepared: PreparedConsentPage, title: string, message: string): { body: string; headers: Record<string, string> } {
  const body = html`<!doctype html>
<html lang="${prepared.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="same-origin">
<title>${title}</title>
<style>${trustedConstant(prepared.css)}</style>
</head>
<body><main><div class="card"><h1>${title}</h1><p>${message}</p></div></main></body>
</html>`.value;
  return {
    body,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; script-src 'none'; style-src 'sha256-${prepared.styleHash}'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
      'cache-control': 'no-store',
    },
  };
}
