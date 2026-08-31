# Third-Party Dependency Notices

Grantex source code is licensed under Apache License 2.0 unless a file states
otherwise. Third-party packages retain their own licenses. Package managers
normally download these packages during installation; this repository does not
relicense them or transfer their copyrights.

## Dependencies requiring explicit distribution attention

| Dependency | Observed use | License | Distribution note |
|---|---|---|---|
| `@img/sharp-libvips-*` (installed by `sharp` in `examples/nextjs-starter`) | Optional platform-specific image-processing runtime | LGPL-3.0-or-later | Distributors of an application or container containing these binaries must preserve the license notices and satisfy the LGPL source, replacement/relinking, and modification requirements applicable to their distribution method. See the [libvips repository](https://github.com/libvips/libvips) and the license files shipped with the npm packages. |
| `caniuse-lite` (installed by the Next.js toolchain) | Browser compatibility data used during builds | CC-BY-4.0 | Preserve attribution and the CC-BY-4.0 license when redistributing the database. See the [caniuse-lite repository](https://github.com/browserslist/caniuse-lite). |
| `json-schema@0.4.0` (transitive through `@ai-sdk/provider` in `examples/vercel-ai-chatbot`) | JSON Schema helpers in the Vercel AI example | AFL-2.1 OR BSD-3-Clause | The package's registry metadata and shipped `LICENSE` allow recipients to choose BSD-3-Clause. Grantex relies on that BSD-3-Clause option. Preserve the package's copyright, license text, and disclaimer when redistributing it. GitHub Dependency Review has an exact purl exception because its dependency metadata currently reports a stricter, inaccurate conjunction that also includes AFL-3.0. |

The automated supply-chain checks read every tracked npm lockfile, reject
unknown or unapproved npm license identifiers, confirm Dependabot coverage for
all tracked package manifests, and verify that the notices above remain when
these dependencies are present. Isolated Python transitive graphs are
classified from pip resolution metadata, and all Go build and test dependency
graphs are classified with `go-licenses`; prohibited or unknown results fail
the security workflow.

This inventory is an engineering control, not a legal opinion. Operators and
downstream distributors remain responsible for reviewing the licenses and
notices in the exact artifacts they ship, including operating-system packages,
base images, optional dependencies, and provider SDKs selected outside this
repository.
