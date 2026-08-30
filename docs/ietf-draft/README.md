# IETF Internet-Draft: Delegated Agent Authorization Protocol (DAAP)

**Current Datatracker draft:** `draft-mishra-oauth-agent-grants-01`
**Security-reviewed working candidate:** `draft-mishra-oauth-agent-grants-02`
**Target:** IETF OAuth Working Group (`oauth@ietf.org`)
**Status:** Active individual Internet-Draft; not IETF-endorsed and not OAuth WG-adopted

Authoritative record: <https://datatracker.ietf.org/doc/draft-mishra-oauth-agent-grants/>.

The Datatracker still shows `-01` until `-02` is submitted and confirmed by email. The `-02` source is not upload-ready until the renderer, idnits, reference, and implementation-report checks below pass.

---

## Document Sources

| File | Purpose |
|------|---------|
| [`draft-mishra-oauth-agent-grants-02.md`](./draft-mishra-oauth-agent-grants-02.md) | Security-reviewed working source in kramdown-rfc2629 Markdown |
| [`implementation-report.md`](./implementation-report.md) | Reference implementation status for reviewers |
| [`extensions/README.md`](./extensions/README.md) | Candidate follow-on topics intentionally excluded from the core profile |
| `draft-mishra-oauth-agent-grants-01.*` | Last published revision artifacts |
| `draft-mishra-oauth-agent-grants-00.*` | Initial submitted revision artifacts |

Do not edit the published `-00` or `-01` artifacts when preparing the next submission. Keep each submitted revision immutable in git so reviewer diffs remain meaningful.

---

## What Changed in `-02`

- Narrowed DAAP to an OAuth profile; Grantex `/v1/*` paths are now a non-normative mapping.
- Requires authenticated Principal consent; developer credentials and policy `allow` decisions cannot substitute for it.
- Requires PAR, exact redirects, state, PKCE S256, a resource indicator, and sender-constrained tokens.
- Uses standard `scope`, `client_id`, `cnf`, and RFC 8693 `act` semantics instead of duplicate short claims.
- Defines safety properties for bounded lost-response refresh recovery without standardizing a premature wire parameter.
- Makes DID use optional and requires proof of possession before an agent key is trusted.
- Moves audit, financial budgets, policy, events, and credential vaults to candidate extension work.
- Rewrites the implementation report as a partial-conformance gap matrix.

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

- `git diff --check` is clean.
- `draft-mishra-oauth-agent-grants-02.xml` renders successfully.
- `draft-mishra-oauth-agent-grants-02.txt` has no blocking idnits errors.
- Every normative reference is used and current Internet-Draft references resolve.
- Datatracker metadata shows intended status as Informational after submission.
- The formal author email is `mishra.sanjeev@gmail.com`; `sanjeev@orchestrum.in` is prominently listed as the alternate author contact in the draft body.
- The implementation report still matches current package versions.

---

## Submitting to the IETF Datatracker

1. Render `draft-mishra-oauth-agent-grants-02.xml`.
2. Go to <https://datatracker.ietf.org/submit/>.
3. Upload `draft-mishra-oauth-agent-grants-02.xml` or `.txt`.
4. Confirm the submission from the email sent to the formal author address, `mishra.sanjeev@gmail.com`.
5. Verify that the Datatracker page shows revision `-02`.

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
[oauth] Updated individual draft: draft-mishra-oauth-agent-grants-02 (DAAP)
```

Suggested ask:

```text
The -02 revision narrows DAAP to a high-assurance OAuth profile. It now requires
PAR, exact redirects, PKCE, resource and sender binding, and authenticated human
consent; it uses RFC 8693 for delegation and moves product operations into
separate candidate-extension work.

Feedback requested:

1. Is a strict profile for agent client instances useful, or are existing OAuth
   deployment profiles sufficient?
2. Should sender constraint be mandatory for all agent clients or only for
   high-impact resources?
3. Does the RFC 8693 delegation treatment overlap incorrectly with current
   identity-chaining, transaction-token, or multi-agent work?
4. Is bounded refresh lost-response recovery worth separate wire-level work?
5. Would the WG consider agenda time at IETF 127 for this narrowed scope?
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
