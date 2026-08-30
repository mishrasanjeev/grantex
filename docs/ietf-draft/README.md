# IETF Internet-Draft: Delegated Agent Authorization Protocol (DAAP)

**Current Datatracker draft:** `draft-mishra-oauth-agent-grants-02`
**Security-reviewed working candidate:** `draft-mishra-oauth-agent-grants-03`
**Target:** IETF OAuth Working Group (`oauth@ietf.org`)
**Status:** Active individual Internet-Draft; not IETF-endorsed and not OAuth WG-adopted

Authoritative record: <https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/>.

Revision `-02` was posted on 2026-08-30. The `-03` source is the next candidate and must pass the renderer, idnits, reference, implementation-report, code-review, and independent-review checks below before upload.

> **Submission hold:** Do not upload revision `-03` before 2026-09-09. Review it from 2026-09-06 through 2026-09-09, then obtain a new explicit approval from Sanjeev Kumar. No script or CI job may submit the draft automatically.

---

## Document Sources

| File | Purpose |
|------|---------|
| [`draft-mishra-oauth-agent-grants-03.md`](./draft-mishra-oauth-agent-grants-03.md) | Security-reviewed working source in kramdown-rfc2629 Markdown |
| [`implementation-report.md`](./implementation-report.md) | Reference implementation status for reviewers |
| [`revision-03-brutal-review.md`](./revision-03-brutal-review.md) | Adversarial review, open evidence gaps, and submission gate |
| [`test-vectors/`](./test-vectors/) | Vendor-neutral behavioral cases for independent harnesses |
| [`extensions/README.md`](./extensions/README.md) | Candidate follow-on topics intentionally excluded from the core profile |
| `draft-mishra-oauth-agent-grants-02.*` | Last published revision artifacts |
| `draft-mishra-oauth-agent-grants-01.*` | Earlier published revision artifacts |
| `draft-mishra-oauth-agent-grants-00.*` | Initial submitted revision artifacts |

Do not edit the published `-00`, `-01`, or `-02` artifacts when preparing the next submission. Keep each submitted revision immutable in git so reviewer diffs remain meaningful.

---

## What Changed in `-03`

- Defines separate client, authorization-server, and resource-server conformance roles.
- Defines the RFC 8414 metadata required to discover the profile safely.
- Makes DPoP mandatory to implement and binds authorization codes to DPoP keys through PAR.
- Treats sender keys as binding material, not stable agent identity, and points to current client-instance work for attested identity.
- Requires RFC 9207 issuer validation in authorization responses.
- Restricts RFC 8693 attenuation to the same client instance, sender key, and resource with exact scope-set containment.
- Leaves cross-instance delegation and actor-chain proof formats to companion specifications.
- Requires RFC 7009 revocation and refresh-family invalidation.
- Makes lost-response refresh recovery explicitly non-interoperable implementation guidance.
- Expands comparisons with current OAuth agent, attenuation, identity-chaining, and transaction-token work.

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
kdrfc draft-mishra-oauth-agent-grants-03.md

# RFC XML -> text (canonical IETF format)
xml2rfc draft-mishra-oauth-agent-grants-03.xml --text

# RFC XML -> HTML
xml2rfc draft-mishra-oauth-agent-grants-03.xml --html

# RFC XML -> PDF, optional
xml2rfc draft-mishra-oauth-agent-grants-03.xml --pdf
```

Output files: `draft-mishra-oauth-agent-grants-03.txt`, `.html`, and optionally `.pdf`.

If local Ruby/xml2rfc tooling is unavailable, paste the Markdown or XML into the [IETF Author Tools](https://author-tools.ietf.org/) renderer and use the generated XML/TXT artifacts.

---

## Pre-Submission Checklist

Run these checks before uploading:

```bash
cd docs/ietf-draft
idnits draft-mishra-oauth-agent-grants-03.txt
```

Confirm:

- `git diff --check` is clean.
- `draft-mishra-oauth-agent-grants-03.xml` renders successfully.
- `draft-mishra-oauth-agent-grants-03.txt` has no blocking idnits errors.
- Every normative reference is used and current Internet-Draft references resolve.
- Datatracker metadata shows intended status as Informational after submission.
- The formal author email is `mishra.sanjeev@gmail.com`; `sanjeev@orchestrum.in` is prominently listed as the alternate author contact in the draft body.
- The implementation report still matches current package versions.

---

## Submitting to the IETF Datatracker

Do not perform these steps before 2026-09-09. Even after that date, proceed
only after every checklist item is current and Sanjeev Kumar gives a new,
explicit upload and IETF-rights confirmation for the final artifacts.

1. Set the front-matter date to the actual upload date and render `draft-mishra-oauth-agent-grants-03.xml`.
2. Go to <https://datatracker.ietf.org/submit/>.
3. Upload `draft-mishra-oauth-agent-grants-03.xml` or `.txt`.
4. Confirm the submission from the email sent to the formal author address, `mishra.sanjeev@gmail.com`.
5. Verify that the Datatracker page shows revision `-03`.

The rendered draft also identifies `sanjeev@orchestrum.in` as the alternate author contact. RFCXML permits one structured email address per author record, so the Gmail address remains the formal Datatracker contact and both addresses appear together in the draft's **Discussion Venues** section.

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
[oauth] Updated individual draft: draft-mishra-oauth-agent-grants-03 (DAAP)
```

Suggested ask:

```text
The -03 revision defines a high-assurance OAuth profile with explicit
conformance roles and metadata. It binds authorization codes to DPoP keys
through PAR, requires RFC 9207 issuer validation, and narrows RFC 8693
delegation to exact scope attenuation for the same resource.

Feedback requested:

1. Is a strict profile for agent client instances useful, or are existing OAuth
   deployment profiles sufficient?
2. Is DPoP mandatory to implement the right sender-constraint baseline?
3. Is same-instance, same-resource, exact-scope RFC 8693 attenuation useful and
   narrow enough for a first profile?
4. Does the profile overlap incorrectly with current AAP, attenuating-token,
   identity-chaining, transaction-token, or multi-agent work?
5. Is refresh lost-response recovery worth a separate wire-level document?
```

---

## Dates

- `-02` expires: 2027-03-03
- IETF 127: 2026-11-14 through 2026-11-20, San Francisco
- BOF proposal cutoff: 2026-09-18
- WG meeting request cutoff: 2026-10-02
- IETF 127 Internet-Draft submission cutoff: 2026-11-02 23:59 UTC

The published `-02` remains active through 2027-03-03. Revision `-03` is under review from 2026-09-06 through 2026-09-09 and must not be uploaded before 2026-09-09. This still leaves substantial time before the IETF 127 submission cutoff.

---

## Path Toward WG Adoption

| Stage | Action |
|-------|--------|
| Individual I-D | Submit `draft-mishra-oauth-agent-grants-03` to Datatracker |
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
