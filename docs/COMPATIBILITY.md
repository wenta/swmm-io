# File formats, correctness boundaries and validation

## Supported surfaces

- **`.inp`**: text-preserving section parser, raw records for all sections, 51 registered schema descriptors, typed common network objects, immutable targeted edits. Some descriptors are variable layouts, and not all variations have full semantic interpretation.
- **`.out`**: supported EPA SWMM 5.x binary layout and versioned metadata, per-period results, pollutant metadata, static stored properties, random/batched/streaming reads. Actual static properties depend on what the solver wrote; `.out` **does not contain the full `.inp` configuration**.
- **`.rpt`**: report headers, error/warning messages and recognized continuity-summary metrics; reports may vary across solver versions and configuration.

## Semantic details that must not change with the cache

| Input | `get()` result | `numericColumn()` / cached bytes |
|---|---|---|
| `C1 … 12` numeric field | `12` as number | `12` |
| `C1 … 0` | `0` | `0` |
| Numeric literal `*` | `'*'` (string) | `NaN` internally; `get()` falls back |
| Numeric field absent | `undefined` | `NaN` internally; `get()` falls back |
| Invalid literal `3abc` | `SyntaxError` | Strict `materialize()` throws and rolls back |
| Unknown ID | `undefined` | Never fake a zero |
| Duplicate ID rows | First record for `get()` | All rows retained in positional order |
| Untouched input text | Byte-equivalent after decoding | Cache never rewrites it |

The original input string remains unchanged; no units, solver defaults, missing values or coordinate reference system assumptions are invented. Quoted IDs, semicolon comments, UTF-8 BOM, line endings and repeated section headers are explicitly tested. A JavaScript string index is a UTF-16 code-unit position, not a byte offset; this does not matter for in-memory text lookups, but matters when integrating with file readers.

## Column materialization scope

A fixed-layout numeric field can be cached. A variable-layout field is **intentionally not cached** in the current schema registry. For example, `OUTFALLS` has different positions depending on type; the `INFILTRATION` method depends on options; `XSECTIONS` geometry meanings vary with shape; `LID_CONTROLS` contains heterogeneous layers. Use the lazy resolver and raw fields rather than forcing a misleading column.

Cache failures are not model validation failures. An automatic cache promotion is optional optimization and cannot introduce a parsing failure from a different record; a manual materialization request validates the selected entire column and may therefore reveal invalid values elsewhere in the section.

## Integration test strategy

1. **Unit tests:** source text fidelity, quoted identifiers, blank lines, comments, duplicate IDs, missing values, integer conversion, all cache policies and cancellation/eviction behavior.
2. **Real model fixtures:** run `test/validate-real.mjs` against original files from authorized sources. The harness downloads files only when explicitly invoked with `--download`; the repository does not embed third-party model data.
3. **Numerical compatibility:** generate output with a trusted EPA SWMM build and compare sampled values to the official Output API, including all categories/variables and pollutant columns with justified floating-point tolerance. This phase remains **incomplete**.
4. **Stress:** large (multi-million row) source strings and output files; detect OOM, unexpected allocation patterns and oversized `Uint32` offsets. Limits must fail explicitly, not silently wrap.

The real validation corpus includes Norfolk Brambleton/Hague models and EPA test cases such as Froude, 72/5 H&H, AkanYen and 3 Pumps, as well as optional larger EPA and NCIMM models. Such projects can contain third-party licensing terms. **Do not copy them into a public source package without checking individual rights.**

## Known limitations

- Not an EPA SWMM solver or comprehensive schema validator.
- Not all 51 descriptors represent fully typed context-dependent rows; custom vendor extensions stay accessible as raw tokens.
- No built-in ZIP/GIS import, shapefile parser, projection conversion or hydrologic parameter defaults.
- Cache memory cap includes only owned numeric typed-array payload bytes, not process RSS.
- `borrowColumn()` yields a mutable JS typed array by language design; users must treat it as read-only.
- Large real `.out` files have not all been verified against the native SWMM Output API; binary structural parsing alone does not prove numerical equivalence.
- Build tested here in Node.js. Browser/Web Worker APIs follow standard ES/Blob APIs but are not covered by an end-to-end browser automation suite.


For the current batch OUT query API, see [QUERY-ENGINE.md](QUERY-ENGINE.md). Independent numerical verification remains an open requirement; see [VERIFY-NATIVE.md](VERIFY-NATIVE.md).
## Large query engine correctness limits

`query()` preserves the on-disk `Float32` values and the request/period order, but cannot verify simulation correctness: the native EPA output API and solver remain external reference implementations. `aggregateMany()` ignores non-finite values for its min/max/mean and counts them separately. Planning heuristics can increase transferred bytes to reduce logical I/O calls. Neither the query engine nor sidecar indexes modify `.out` files.
