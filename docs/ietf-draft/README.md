# IETF Internet-Draft: Delegated Agent Authorization Protocol (DAAP)

**Current Datatracker draft:** `draft-mishra-oauth-agent-grants-01`
**Prepared source candidate:** `draft-mishra-oauth-agent-grants-02`
**Target:** IETF OAuth Working Group (`oauth@ietf.org`)
**Status:** Active individual Internet-Draft; not IETF-endorsed and not OAuth WG-adopted

Authoritative record: <https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/>.

The Datatracker still shows `-01` until `-02` is submitted and confirmed by email. The `-02` source in this directory is the next submission candidate.

---

## Document Sources

| File | Purpose |
|------|---------|
| [`draft-mishra-oauth-agent-grants-02.md`](./draft-mishra-oauth-agent-grants-02.md) | Current submission candidate in kramdown-rfc2629 Markdown |
| [`implementation-report.md`](./implementation-report.md) | Reference implementation status for reviewers |
| `draft-mishra-oauth-agent-grants-01.*` | Last published revision artifacts |
| `draft-mishra-oauth-agent-grants-00.*` | Initial submitted revision artifacts |

Do not edit the published `-00` or `-01` artifacts when preparing the next submission. Keep each submitted revision immutable in git so reviewer diffs remain meaningful.

---

## What Changed in `-02`

- Updated author organization and contact metadata to Orchestrum Technologies LLP / Sanjeev Kumar.
- Clarified that DAAP is vendor-neutral and that Grantex is a reference implementation.
- Replaced Grantex-specific normative examples with reserved example identifiers/domains.
- Added a bounded refresh-token lost-response recovery rule: maximum 300 seconds, same already-rotated response, no grant-lifetime extension.
- Added `/v1/token/refresh` to the required protocol surface.
- Added OAuth Security BCP, PKCE, PAR, DPoP, mTLS, and Protected Resource Metadata alignment.
- Added discussion venues and relationship text for adjacent OAuth agent/delegation drafts.
- Expanded privacy and audit-log minimization guidance.
- Refreshed the implementation report with current repository package versions.

---

## Rendering the Draft Locally

### Prerequisites

```bash
gem install kramdown-rfc2629
pip install xml2rfc
```

### Build

```bash
cd docs/ietf-draft

# Markdown -> RFC XML
kdrfc draft-mishra-oauth-agent-grants-02.md

# RFC XML -> text (canonical IETF format)
xml2rfc draft-mishra-oauth-agent-grants-02.xml --text

# RFC XML -> HTML
xml2rfc draft-mishra-oauth-agent-grants-02.xml --html

# RFC XML -> PDF, optional
xml2rfc draft-mishra-oauth-agent-grants-02.xml --pdf
```

Output files: `draft-mishra-oauth-agent-grants-02.txt`, `.html`, and optionally `.pdf`.

If local Ruby/xml2rfc tooling is unavailable, paste the Markdown or XML into the [IETF Author Tools](https://author-tools.ietf.org/) renderer and use the generated XML/TXT artifacts.

---

## Pre-Submission Checklist

Run these checks before uploading:

```bash
cd docs/ietf-draft
idnits draft-mishra-oauth-agent-grants-02.txt
```

Confirm:

- `draft-mishra-oauth-agent-grants-02.xml` renders successfully.
- `draft-mishra-oauth-agent-grants-02.txt` has no blocking idnits errors.
- Datatracker metadata shows intended status as Informational after submission.
- Author email is correct and reachable for confirmation.
- The implementation report still matches current package versions.

---

## Submitting to the IETF Datatracker

1. Render `draft-mishra-oauth-agent-grants-02.xml`.
2. Go to <https://datatracker.ietf.org/submit/>.
3. Upload `draft-mishra-oauth-agent-grants-02.xml` or `.txt`.
4. Confirm the submission from the email sent to `sanjeev@orchestrum.in`.
5. Verify that the Datatracker page shows revision `-02`.

The draft will continue to appear at:
`https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/`

---

## Announcing to the OAuth Working Group

After Datatracker confirmation, post to the OAuth WG mailing list:

- List: `oauth@ietf.org`
- Archive: <https://mailarchive.ietf.org/arch/browse/oauth/>
- Subscribe: <https://www.ietf.org/mailman/listinfo/oauth>

Suggested subject:

```text
[oauth] Updated individual draft: draft-mishra-oauth-agent-grants-02 (DAAP)
```

Suggested ask:

```text
The -02 revision updates DAAP to be more explicitly vendor-neutral, adds
refresh-token lost-response recovery, aligns the security baseline with current
OAuth BCP work, and adds relationship text for identity chaining, transaction
tokens, and agent-authorization drafts.

Feedback requested:

1. Should DAAP remain a single individual profile, or should parts of it be
   split into narrower drafts?
2. Which pieces overlap with current OAuth WG identity-chaining and transaction
   token work?
3. Are the proposed JWT claim names appropriate for IANA registration, or
   should the draft use longer/descriptive names?
4. Would the WG consider agenda time at IETF 127 for discussion?
```

---

## Dates

- `-01` expires: 2026-09-03
- IETF 127: 2026-11-14 through 2026-11-20, San Francisco
- BOF proposal cutoff: 2026-09-18
- WG meeting request cutoff: 2026-10-02
- IETF 127 Internet-Draft submission cutoff: 2026-11-02 23:59 UTC

Submit `-02` before the `-01` expiry. The IETF 127 cutoff is later, but waiting for that date would allow this draft to expire first.

---

## Path Toward WG Adoption

| Stage | Action |
|-------|--------|
| Individual I-D | Submit `draft-mishra-oauth-agent-grants-02` to Datatracker |
| Mailing list review | Ask OAuth WG for technical feedback and overlap review |
| Agenda time | Ask OAuth chairs whether DAAP should be discussed at IETF 127 |
| Scope refinement | Split or profile the draft if the WG prefers narrower documents |
| WG adoption | Request adoption only after support appears on-list |
| WG I-D | Rename to `draft-ietf-oauth-agent-grants-00` if adopted |
| WGLC | Working Group Last Call |
| IESG review | IESG review and approval |
| RFC publication | RFC Editor publication if approved |

---

## Ownership

Grantex is owned by Orchestrum Technologies LLP. Inventor and owner: Sanjeev Kumar. Ownership contact: [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) or [mishra.sanjeev@gmail.com](mailto:mishra.sanjeev@gmail.com).
