# Changelog

## 0.8.0-beta.1 — npm release candidate

- First public-installable prerelease candidate, built from the 0.8.0 query-engine code.
- Added reproducible TypeScript dependency lock, packaging checks, TypeScript consumer compilation, Node/Blob compatibility smoke tests and CI/release workflows.
- Documented discovery of actual `.out` IDs and variables; removed stale current-document links.
- Added publication safeguards and explicit known validation limitations.
- No change to numeric calculations or `.out` query strategy in this release.


## 0.8.0 — Multi-channel query engine

- Added `OutReader.explainQuery()`, `query()`, `queryStream()` and `aggregateMany()` for mixed-channel and Cartesian-product queries.
- Added bounded, columnar Float32Array result layout and per-chunk async iteration.
- Added sparse / grouped / sequential I/O planning with a configurable 64× default cap on bulk read amplification.
- Added streaming min/max/mean with non-finite counts and compensated summation.
- Added parity tests, counter-instrumented benchmark for 100/1,000/10,000 links and a real-file CLI example.
- Rewrote top-level README for current usage; moved historical version guides to docs/history/.
- No new runtime dependencies. HTTP API remains a separate project.

## [0.7.1] - 2026-10-26

### Added
- `OutIndexCache`: resident LRU with byte and entry budgets, single-flight builds, optional sidecar persistence, cache stats and explicit eviction.
- `AdaptiveOutIndex`: conservative observable direct-to-index promotion for repeat chart workloads; keeps short series direct by default.
- Node diagnostic CLI `--trust-stat-key` opt-in; renamed identity stage and explicit identityMode reporting.
- 8 new regression tests, performance benchmark and English/Polish docs.

### Improved
- SHA-256 diagnostic hashing uses a reusable 1 MiB positioned-read buffer, checks for file changes and no longer opens an independent source stream.
- In-flight waiting caller can abort its wait without interrupting a separately initiated build.

### Compatibility
- All 0.7.0 exports and file formats remain available. No HTTP API was added.

---
# Changelog

## 0.7.0 — Indexed result queries and memory diagnostics

- Added exact indexed envelopes and range min/max via `OutSeriesIndex`, with per-channel, bounded-memory opt-in materialization.
- Added sidecar binary serialization, checksums, source key checks, Node Buffer alignment handling, and corruption tests.
- Added CLI for real-model RSS/heap/ArrayBuffer profiling and new synthetic benchmarks.
- Added extensive API/format/performance/Polish documentation.
- Numerical parity with official EPA Output API remains unverified; do not treat synthetic fixtures as independent numeric validation.

## 0.6.0 — 2026-10-26

- `InpProperties.getMany()` and `numericMany()` use shared ID indexes and column-oriented numeric return values; preserve missing/`*` semantics.
- `InpModel.validate()` / `validateInp()` provide opt-in, bounded static diagnostics, without blocking lossless parsing.
- `OutReader.snapshotSelected()` performs bounded and grouped selective result reads.
- Added optional query budgets and cooperative cancellation to `series`, `seriesMany`, `seriesChunks`, `seriesStatistics`, `seriesEnvelope`, `snapshot`.
- Fixed excessive I/O in the automatic read strategy for sparse, wide result records.
- Concurrent IDs/static property reads now share one in-flight load instead of duplicating work.
- Added single-source-read bounds, safe integer checks, chunked all-object snapshot reads, virtual >2 GiB addressing test.
- Added independent reference comparison scripts (`tools/`) and detailed v0.6 documentation/benchmarks.
- **Known gap:** independent numerical comparison with native EPA Output API not executed as part of this release.

All versions before a stable 1.0 release are experimental. Public API may evolve.

## 0.5.0 — Hybrid numeric properties and documentation

### Added
- `InpModel.parse(text, cacheOptions?)` and `new InpModel(document, cacheOptions?)`.
- `ColumnCacheOptions`: `mode: 'lazy' | 'auto'`, `maxBytes`, `minPromotionReads`, `promotionRatio`.
- `properties.materialize(section, fields)` for transactional single-pass extraction of selected **fixed-layout numeric** properties.
- `properties.cachedColumn()` returns a defensive copy; `properties.borrowColumn()` returns an explicit read-only-by-contract zero-copy view.
- `properties.evict(section?,fields?)` and `properties.cacheStats()`.
- Shared `InpDocument.sectionRowCount`, `rowPosition`, and selected-position scanner; no duplicated ID map.
- Tests for auto-promotion, memory caps, malformed values, `*`, missing fields, quoted IDs, repeated sections, immutable edits, and transactional rollback.
- `test/benchmark-cache.mjs` measuring public API cold/lazy, explicit column cache, and automatic promotion across models up to 1m records.
- API, architecture, performance, compatibility, contribution guides, Polish introduction and runnable example.

### Behavior
- Default lazy behavior of `get()` remains intact when cache options are omitted.
- Cached finite `get()` uses array lookup; missing/`*` cells fall back to original parsing, preserving the previous result types.
- Variant-layout sections **cannot** be materialized as fixed numeric columns; their pre-existing lazy typed/raw APIs are unchanged.
- Automatic promotion is strictly an optimization: invalid values elsewhere in a column do not turn an otherwise valid direct `get()` into a failure.

### Limits
- Numerical equivalence against the native SWMM Output API is not yet exhaustively proven.
- Cache limit accounts only for owned numeric typed-array bytes, not JS source/index/heap overhead.
- No automatic cache eviction is performed.

## 0.4.0 — Named properties and one-off columns

- Common typed INP descriptors and per-record variant resolution.
- `properties.get`, `record`, `raw`, `numericColumn`, `layer`.
- Named output static properties.

## 0.3.0 — Streaming output analysis

- Bounded `.out` series chunks, streaming statistics, min/max envelopes, static output properties.

## 0.2.0 — Indexed multi-series I/O

- TypeScript model topology, batched `.out` reads and report diagnostics.
