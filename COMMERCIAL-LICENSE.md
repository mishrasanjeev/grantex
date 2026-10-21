# Commercial licensing

Grantex is owned by Orchestrum Technologies LLP and has two licences:

| Part | Licence | Commercial use |
|---|---|---|
| SDKs and client packages in `packages/`, and `examples/` | Apache License 2.0, open source | Free for any use, including commercial |
| The Grantex server and portal (`apps/`), the protocol specification text, documentation and website | [PolyForm Noncommercial License 1.0.0](LICENSE), from **21 October 2026**, including every update | Needs a written agreement with Orchestrum Technologies LLP |

[LICENSING.md](LICENSING.md) lists the directories exactly. For the
PolyForm-licensed parts, **only self use is free. Commercial use of any sort
needs Orchestrum's prior approval and a written agreement with Orchestrum
Technologies LLP.** Commercial use of the hosted services needs an agreement
too.

This page explains in plain language what that means. The licence texts and
any signed agreement are what govern; this page is not legal advice.

## Free, no agreement needed

- **The SDKs and client packages**, for any purpose, under the Apache License
  2.0: build them into commercial products, run them in production and
  redistribute them, keeping their licence and notices.
- **Self use of the server and portal.** An individual using them for their own
  noncommercial purposes: learning, personal study, research, experiments,
  testing and hobby projects, with no expected commercial application.
- **Other noncommercial purposes the PolyForm licence names.** Use by a
  charitable organisation, educational institution, public research
  organisation, public safety or health organisation, environmental protection
  organisation or government institution, as the licence's "Noncommercial
  Organizations" section describes.
- **Contributing** changes back to this repository (see
  [CONTRIBUTING.md](CONTRIBUTING.md)).

You may change the PolyForm-licensed code and share it for these purposes, as
long as everyone who receives a copy also receives the licence terms and the
`Required Notice:` lines at the top of [LICENSE](LICENSE).

## Needs a written agreement with Orchestrum

Any commercial use of the server, the portal or the other PolyForm-licensed
parts, whatever its size and whether or not money changes hands. Orchestrum
treats all of the following as commercial:

- **Internal use by a for-profit business**, even if nothing is sold: running
  the Grantex auth service or portal for your own staff, products, customers or
  operations, including pilots and proofs of concept.
- **Hosting, SaaS and managed services**: offering the Grantex server, or a
  service built on running it, to other people or organisations, on your
  infrastructure or anyone else's.
- **Resale and distribution**: selling, licensing, bundling or redistributing
  the server, the portal or a changed version of them as part of a commercial
  offering.
- **Embedding**: including the auth service, the portal or the protocol
  specification text in a commercial product, appliance or platform.
- **Consulting and services**: delivering paid consulting, integration,
  implementation, training or support work that runs or deploys the server or
  portal.
- **The hosted services**: commercial use of `grantex.dev`, `api.grantex.dev`
  and related endpoints, whichever SDK or version you use to call them.

If you are not sure whether your use is commercial, treat it as commercial
until Orchestrum confirms otherwise in writing.

## How to obtain a commercial licence

Email [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in) with:

1. your organisation's name and country;
2. the Grantex components and versions you want to use;
3. how you will use them (internal, hosted, embedded, resale or services) and
   who your users are;
4. the expected scale and deployment (self-hosted, cloud, devices); and
5. when you need to start.

Orchestrum will reply with terms. Commercial use may begin only once a written
agreement has been signed by Orchestrum Technologies LLP and you. Sending a
request, or receiving a reply, is not itself a licence.

## Earlier versions and existing users

Releases of the server, portal and other PolyForm-licensed parts published
before 21 October 2026 remain available under the Apache License 2.0 terms they
were released with.

Those terms do not extend to any version, update, fix or security patch of
those parts published on or after 21 October 2026. If you use the Grantex
server or portal commercially today, moving to any later version requires a
written agreement with Orchestrum. The SDKs and client packages are not
affected: they remain Apache-2.0. No version of the Apache License 2.0 grants
rights in the Grantex or AgenticOrg names and logos or access to Orchestrum's
hosted services, so commercial use of those needs Orchestrum's prior written
approval as described in [TRADEMARKS.md](TRADEMARKS.md).

## Material that keeps its own licence

Third-party material in this repository keeps the licence it came with and is
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md): for example the
RFC 8785 test vectors, the copied UCP and ACP JSON Schemas, the IETF
Internet-Draft texts, and all dependencies installed by package managers.

## Contact

Orchestrum Technologies LLP, [sanjeev@orchestrum.in](mailto:sanjeev@orchestrum.in).
