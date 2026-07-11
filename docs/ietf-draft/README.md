# IETF Internet-Draft: Delegated Agent Authorization Protocol (DAAP)

**Draft name:** `draft-mishra-oauth-agent-grants-01`
**Target:** IETF OAuth Working Group (oauth@ietf.org)
**Status:** Active individual Internet-Draft — revision 01 (published March 2, 2026; expires September 3, 2026)

Authoritative record: <https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/>. An individual Internet-Draft is not endorsed by the IETF and has no formal standards standing unless adopted and advanced through the IETF process.

---

## Document

The Internet-Draft is in [`draft-mishra-oauth-agent-grants-01.md`](./draft-mishra-oauth-agent-grants-01.md), written in [kramdown-rfc2629](https://github.com/cabo/kramdown-rfc) format — a Markdown superset that compiles to RFC XML (RFC 7991) and from there to canonical IETF text and HTML.

---

## Rendering the Draft Locally

### Prerequisites

```bash
gem install kramdown-rfc2629
pip install xml2rfc
```

### Build

```bash
# Markdown → RFC XML
kdrfc draft-mishra-oauth-agent-grants-01.md

# RFC XML → text (canonical IETF format)
xml2rfc draft-mishra-oauth-agent-grants-01.xml --text

# RFC XML → HTML
xml2rfc draft-mishra-oauth-agent-grants-01.xml --html

# RFC XML → PDF
xml2rfc draft-mishra-oauth-agent-grants-01.xml --pdf
```

Output files: `draft-mishra-oauth-agent-grants-01.txt`, `.html`, `.pdf`.

Alternatively, paste the XML into the [IETF Author Tools](https://author-tools.ietf.org/) web interface for a one-click render.

---

## Submitting to the IETF Datatracker

1. Render the XML as above, or use `kdrfc` to produce the `.xml` file directly.
2. Go to **https://datatracker.ietf.org/submit/**.
3. Upload `draft-mishra-oauth-agent-grants-01.xml` (or `.txt`).
4. The Datatracker will validate the document, assign a submission ID, and send a confirmation email to the address listed in the author block (`mishra.sanjeev@gmail.com`).
5. Confirm the submission via the email link.

The draft will appear at:
`https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/`

---

## Announcing to the Working Group

Post to the OAuth WG mailing list after the Datatracker submission is confirmed:

- **List:** oauth@ietf.org
- **Archive:** https://mailarchive.ietf.org/arch/browse/oauth/
- **Subscribe:** https://www.ietf.org/mailman/listinfo/oauth

Suggested subject line:
```
[oauth] New individual draft: draft-mishra-oauth-agent-grants-01 (Delegated Agent Authorization Protocol)
```

---

## Revision Process

IETF Internet-Drafts expire after **6 months** from submission. To keep the draft alive:

1. Incorporate working group feedback.
2. Increment the version number (`-01`, `-02`, …).
3. Re-submit to the Datatracker before the expiry date.

The expiry date is shown on the Datatracker page for the draft.

---

## Path to Standards Track

| Stage | Action |
|-------|--------|
| Individual I-D | Submit `draft-mishra-oauth-agent-grants-01` to Datatracker ← **current** |
| WG adoption | Request adoption at an IETF meeting or on the mailing list after gathering support |
| WG I-D | Rename to `draft-ietf-oauth-agent-grants-00` upon WG adoption |
| WGLC | Working Group Last Call — two-week review period |
| IESG review | Internet Engineering Steering Group review and approval |
| RFC publication | Assigned an RFC number by the RFC Editor |

---

## Related RFCs

| RFC | Title | Relationship |
|-----|-------|--------------|
| RFC 6749 | OAuth 2.0 | Foundation — DAAP extends the grant flow model |
| RFC 7519 | JSON Web Token (JWT) | Grant Token format |
| RFC 7517 | JSON Web Key (JWK) | JWKS endpoint for offline verification |
| RFC 7518 | JSON Web Algorithms | RS256 algorithm specification |
| RFC 7636 | PKCE | Planned for DAAP v1.1 |
| RFC 8693 | Token Exchange | Related — DAAP delegation vs. general token exchange |
| RFC 7662 | Token Introspection | Related — DAAP `/v1/tokens/verify` serves a similar role |
| RFC 8725 | JWT Best Practices | Algorithm restriction guidance |
