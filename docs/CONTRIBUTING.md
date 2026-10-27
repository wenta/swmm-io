# Contributing and maintainer workflow

## Preconditions

- Node.js >=18 and TypeScript 5.x; `npm install` adds only a TypeScript **development** dependency.
- Use TypeScript `strict`, `noUncheckedIndexedAccess`, `noFallthroughCasesInSwitch` and `NodeNext` ESM settings already in `tsconfig.json`.
- Keep runtime dependency count at zero unless there is a measurable and justified reason to change it.
- Write source code comments and JSDoc in English. Public docs may be translated.

## Verification commands

```sh
npm ci                     # requires registry access for the locked dev dependency
npm run build
npm test
npm run bench:cache
npm run bench:access         # legacy 0.4 comparison prototype, NOT public API
node test/validate-real.mjs --download        # optional, requires network
npm pack --dry-run
```

## Contribution contract

Every optimization should specify **(a)** the workload, **(b)** the expected correctness invariant, **(c)** the memory tradeoff, **(d)** an instrumented before/after benchmark of the shipped API. Don't report pure parser nanoseconds as end-to-end model opening time. Consider large but sparse reads, missing tokens, malformed content and long identifiers.

### When adding a field schema

- First decide whether the section is fixed-position or record-variant. Mark ambiguous or option-dependent sections `variableLayout: true`.
- Match the official SWMM token meaning and numeric type; do not assign plausible numeric names to ambiguous positions.
- Add a unit/semantic test for that section, plus quoted ID/comments and missing/`*` tests when applicable.
- Only fixed-layout numeric fields may use `InpColumnStore.materialize` until a variant-aware representation is implemented.
- Preserve lossless `document.toString()` behavior.

### When changing the cache

- The shared `InpDocument.rowPosition` must agree with the row order seen by `forEachSelectedFields`.
- Cache builds must be transactional; an invalid numeric literal cannot leave a partially published array.
- `get()` with missing/`*` must return exactly the same value as before materialization.
- Cache budget counts owned `Float64Array.byteLength`, not arbitrary JS `Map` overhead; report both if publishing benchmarks.
- No automatic eviction without an explicit policy and measured proof against thrashing.
- `borrowColumn` references must not be mutated inside the library or by tests except where deliberately testing safety pitfalls.

## Release checklist

1. Update package semver, API docs and architecture notes.
2. `npm test` must pass; compare recorded checksums.
3. Run synthetic cache benchmark and at least a representative real-model validation when available.
4. `npm pack --dry-run`, then install tarball in a clean directory and test an ESM import.
5. Confirm no third-party model datasets, machine-specific paths, secrets or large generated outputs were accidentally included.
6. Make performance claims explicit about CPU, Node, fixture size, measurement method and limits.


The current API and limits are described in the root README and [QUERY-ENGINE.md](QUERY-ENGINE.md). Historical changes belong in CHANGELOG.md.
