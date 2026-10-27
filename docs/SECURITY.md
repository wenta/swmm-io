# Security and untrusted input

`swmm-io` parses user-provided `.inp`, `.rpt` and binary `.out` files. No parser is a substitute for isolating untrusted workloads. Use upload limits, per-request memory/I/O/time budgets, and application-level authentication when exposing it from a server. The library does not implement an HTTP server, permissions, sandboxing or antivirus scanning.

- `OutReader.query()`, `queryStream()` and other read APIs accept resource limits; check the defaults and set conservative limits for your environment.
- `OutReader.open()` interprets binary metadata but does not certify arbitrary input as safe. Reject files with implausible provenance and apply limits at upload/storage boundaries.
- `.swmxidx` sidecar indexes must only be reused with a source identity whose trust level is appropriate for the environment. A metadata-only `trusted-stat` fingerprint is not a cryptographic content proof.
- `InpModel.parse()` retains the full decoded input string; the application must limit maximum input size before decoding.
- Do not expose local `FileHandleSource` handles or trusted-stat shortcut to untrusted tenants without isolation.

This is a beta release with incomplete malicious-file fuzzing and native numerical parity. Report vulnerabilities privately through the source repository's security reporting mechanism **once the maintainer has configured it**, rather than posting an exploitable demonstration to public issues. No private security contact is supplied until a real repository has been chosen.
