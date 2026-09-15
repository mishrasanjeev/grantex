# Canonicalisation fixtures

Shared by the Python SDK, the TypeScript SDK and the auth service. The rules
are in [`spec/canonicalization.md`](../../canonicalization.md).

| Path | Contents |
|---|---|
| `rfc8785/input/`, `rfc8785/output/`, `rfc8785/outhex/` | RFC 8785 test vectors. |
| `es6-numbers.json` | Generator inputs and checksums of the RFC 8785 ES6 number test. |
| `parity.json` | Additional Grantex cases, including inputs that must be refused. |

## Provenance and licence

The files in `rfc8785/` and the `static_u64` values and checksums in
`es6-numbers.json` are copied unmodified from the `testdata` directory of the
RFC 8785 reference implementation,
<https://github.com/cyberphone/json-canonicalization>, Copyright 2018 Anders
Rundgren, licensed under the Apache License, Version 2.0. They are test data;
no code from that repository is included.

The files in `rfc8785/` must stay byte-for-byte identical to the originals
(no trailing newline, LF line endings), which `.gitattributes` in this
directory protects.

`parity.json` is part of Grantex and is licensed under the Apache License,
Version 2.0, like the rest of this repository.
