# Cookie Policy (Draft)

**Status:** Draft. Subject to legal review.
**Last reviewed:** 2026-05-24
**Applies to:** the marketing site (`grantex.dev`), the documentation site (`docs.grantex.dev`), and the developer portal (`grantex.dev/dashboard`).

This page describes the cookies and similar storage mechanisms used by the public Grantex sites today, based on what is wired up in this repository. **Self-hosted Grantex deployments serve the marketing site only if the operator publishes it; the analytics cookie below is in the source under the maintainers' GA ID and is easy to remove for a fork.**

## Categories in use

### Strictly necessary

These are required to operate the developer portal and consent UI. They cannot be disabled.

| Name | Purpose | Set by | Duration |
|---|---|---|---|
| `__session` | Developer-portal authenticated session | `apps/portal` | Session |
| `csrf` | CSRF double-submit token on consent and portal forms | auth-service consent challenge route | Session |

No third-party cookies are set by the auth-service or the developer portal.

### Analytics

The marketing site only uses Google Analytics for aggregate traffic data, which we use to decide where to invest in docs and integrations.

| Name | Purpose | Set by | Duration |
|---|---|---|---|
| `_ga`, `_gid`, `_ga_*` | Google Analytics aggregate site traffic | Google Analytics (GA4 property `G-DNXYVLS5NY`) | Up to 2 years |

You can opt out of Google Analytics by using a browser extension such as the official Google Analytics Opt-out, by enabling Do Not Track, or by blocking the `googletagmanager.com` and `google-analytics.com` domains in your browser. The marketing site does not currently surface a per-visitor banner-style consent prompt. **TBD:** a CMP-style consent banner is on the follow-up list for the EU launch — see `docs/reports/enterprise-readiness-brutal-review-2026-05-24.md` item H-3 (legal-link work).

### Marketing / advertising

None. Grantex does not currently run third-party ad pixels (no Facebook Pixel, no LinkedIn Insight Tag, no Google Ads tag) and does not retarget visitors.

### Session replay or behavioural recording

None. No session-replay tooling (FullStory, Hotjar, LogRocket) is referenced anywhere in the repo.

## Local / session storage

The interactive playgrounds (`web/commerce-playground.html`, `web/x402-playground/`, `web/mpp-demo/`) use `localStorage` to remember the API base URL, sample payloads, and form values you typed. Nothing is sent off-device beyond what you explicitly submit through the UI.

## How to clear

Use your browser's standard "Clear site data" controls for `grantex.dev` and `docs.grantex.dev`. Clearing site data signs you out of the portal and resets the playgrounds to defaults.

## Contact

Cookie or tracking questions: `security@grantex.dev`.
