# Public API reference — swmm-io

The TypeScript `.d.ts` files in `dist/` are the definitive signatures. The examples here focus on semantics, lifecycle and performance constraints. Package exports use ESM and do not require Node in browser bundles.

## Input: `InpDocument` and `InpModel`

`InpDocument.parse(source: string): InpDocument` records section boundaries, retaining the **original JavaScript string** and preserving unknown sections, line endings, whitespace and comments. No parsed object graph is created on open. Methods include:

| Method | Meaning and cost |
|---|---|
| `sections`, `hasSection(name)` | Registered section names (uppercase internally), no record scan |
| `rows(name)` | Lazy iterator of `{section,line,fields,comment}`; splits tokens as yielded |
| `ids(name)` | Lazy iterator of first tokens |
| `rowById(name,id)` | First matching record; initial call builds ID index for this section |
| `rowsById(name,id)` | All matching records, including repeated time-series/curve points |
| `sectionRowCount(name)` | Number of indexed data records; shares existing section index |
| `rowPosition(name,id)` | Zero-based position of first row, or `undefined` |
| `forEachField(name,index,callback)` | Single positional token read per row, no per-row token array |
| `forEachSelectedFields(name,positions,callback)` | Multi-field scan; **scratch fields array is reused**: do not retain it |
| `replaceRow`, `removeRow`, `appendRow` | Return a **new document**, never mutate the old one |
| `toString()` | Lossless text round trip |

`InpModel.parse(text, cacheOptions?)` creates a model with `.document` and `.properties`. The `links()`, `nodes()`, `subcatchments()` methods are lazy typed iterators; `topology()` builds maps for network analysis on explicit request. `options()` returns input configuration values. `new InpModel(existingDocument, cacheOptions?)` is also supported.

## Named properties: `model.properties`

The property views use registered section descriptors, but **are not a complete SWMM semantic validator**. Use `inpSchema(section)` and `inpSchemas()` to enumerate known sections; use `raw()` to access any input position.

| Method | Behavior |
|---|---|
| `get(section,id,field)` | Typed field on first matching row, returns `number\|string\|undefined`; cached finite numeric fields bypass tokenization |
| `record(section,id)` | One record object with named fields |
| `records(section)` | Iterator of record objects |
| `raw(section,id,index)` | Positional token as string, even in unregistered sections |
| `rows(section,id)` | All raw matching records |
| `layer(controlId,layer)` | Specific LID control layer |
| `numericColumn(section,field)` | `{ids,values:Float64Array}`; always a new, safe result, `NaN` for missing or `*` |

### Cache configuration

```ts
const model = InpModel.parse(text, {
  mode: 'auto',           // 'lazy' (default) or 'auto'
  maxBytes: 32 << 20,     // default 64 MiB, nonnegative integer
  minPromotionReads: 512,// default 256, positive integer
  promotionRatio: 0.2,   // default 0.15, finite positive number
});
```

`lazy` means no automatic promotion, **not** an inability to manually materialize. `auto` tracks per-field reads and promotes only a fixed-layout numeric field if it fits within the cache budget. It does not evict columns automatically. Failed automatic promotion caused by bad data in an unrelated row is suppressed: the current `get()` remains valid. `materialize()` is strict and throws.

### Cache lifecycle

```ts
const p = model.properties;
const info = p.materialize('CONDUITS', ['length', 'roughness']);
// info = {section, rows, cachedFields, newFields, addedBytes, totalCachedBytes}
const copy = p.cachedColumn('CONDUITS','length');   // Float64Array copy | undefined
const unsafe = p.borrowColumn('CONDUITS','length'); // internal Float64Array | undefined
const stats = p.cacheStats();
p.evict('CONDUITS', ['roughness']); // returns bytes removed
p.evict('CONDUITS');                // remove section's columns
p.evict();                          // remove everything
```

**Array ownership:** `cachedColumn()` returns a *copy*. Modifying it never changes future `get()` results. `borrowColumn()` returns the original array, making copies unnecessary in high-throughput applications; modifying it causes **undefined application behavior** because all other lookups share its bytes. Do not pass a borrowed column to an API that might mutate it. The array may remain reachable after eviction: eviction only releases the cache's reference.

**Memory accounting:** `usedBytes` and `maxBytes` describe numeric `Float64Array` payloads only. The retained source text, section indexes, JS map/string overhead, temporary buffers and V8 garbage-collection effects are **not** included. A `materialize` request that would exceed `maxBytes` throws `RangeError` before allocating its new column arrays. It never silently evicts other fields. Multiple requested fields are built in **one scan** and committed together only after full validation.

**Eligible fields:** numeric descriptors (`number` or `integer`) from sections with `variableLayout === false`. Other layouts cannot be cached by position at present. They continue to work with lazy typed/raw APIs. A materialization attempt on an unsupported layout throws instead of silently using the wrong column.

**Sentinel rules:** raw numeric `*` returns the literal string `'*'` from `get()`. A missing numeric position returns `undefined`. Cached arrays represent either condition as `NaN`, so `get()` falls back to the source record for that particular cell. Numeric `NaN`, `Infinity`, mixed tokens and unsafe integers (for `integer` fields) are rejected; zero is never silently substituted.

**Duplicate IDs:** the cache row order follows physical document order, including duplicate IDs. `get(section,id,field)` uses the **first** matching ID; `numericColumn()` returns all entries, including duplicates, with their own row positions. Multiple sections named `[CONDUITS]` are treated as one logical section in source order.

### Examples

```ts
const p = InpModel.parse(source, { mode:'lazy', maxBytes: 8*1024*1024 }).properties;
const length = p.get('CONDUITS', 'C8', 'length');
p.materialize('CONDUITS', ['length']);
const lengthAgain = p.get('CONDUITS', 'C8', 'length'); // same value
const column = p.cachedColumn('CONDUITS','length');  // safe Float64Array copy
console.log(length, lengthAgain, column?.length, p.cacheStats().hits);
```

## Binary output: `OutReader`

`await OutReader.open(source: ByteSource, options?)` reads a small header/trailer and the necessary metadata; it does not load full time-series data. Return values are in the units configured for the SWMM simulation. Closing a reader delegates to the underlying source if it supports `close`.

| Method | Return | Description |
|---|---|---|
| `ids(kind)` | `Promise<readonly string[]>` | Names for `subcatch`, `node`, `link`, `pollutant` |
| `columnNames(kind)` | array | Numeric result codes and display names |
| `columns(kind)` | numeric codes | Available variables |
| `properties(kind)` | property view | Static metadata stored in `.out` |
| `propertyValue(kind,object,name)` | number | Named stored static field, e.g. link `length` |
| `value(kind,object,attribute,period)` | number | One sample |
| `objectResult(kind,object,period)` | `Float32Array` | Variables for one object/period |
| `series(kind,object,attribute,start?,end?,strategy?)` | `Float32Array` | One time series |
| `seriesMany(requests,start?,end?,strategy?)` | array of `Float32Array` | Shared I/O across multiple series |
| `snapshot(kind,attribute,period)` | `Float32Array` | Values across all objects for one period |
| `seriesChunks(...)` | async iterator | Bounded chunks for a long series |
| `seriesStatistics(...)` | statistics | Streaming min/max/mean and finite counts |
| `seriesEnvelope(...)` | points | Min/max downsampling preserving local extremes |
| `timestampsSerial(start?,end?)` | `Float64Array` | SWMM serial days (no implicit timezone) |
| `timestamp(period)` | `Date` | UTC date conversion from SWMM serial day |
| `pollutantUnits()`, `pollutantSeries(...)` | metadata/values | Quality pollutant data |
| `close()` | promise | Delegate to source |

All period ranges are **zero-based half-open** `[start,end)`. Use a `BlobSource` for browser files, `MemorySource` for complete byte arrays, or `FileHandleSource` for Node positioned disk reads. See `examples/inspect.mjs` and `examples/verify-out.mjs`.

For output-series access, `strategy` is `auto`, `bulk`, or `sparse`, independent of the **input-property cache mode**. `bulk` performs larger sequential reads, often favorable when many attributes are requested; `sparse` coalesces narrower reads. Their relative performance depends on storage latency, model stride, number of periods and query selectivity.

## Reports: `RptDocument`

```ts
const report = RptDocument.parse(reportText);
console.log(report.errors, report.warnings);
console.log([...report.continuityErrors()]);
console.log(report.sectionsNamed('Flow Routing Continuity'));
```

The report parser is intentionally text-preserving and tolerant of different banner layouts; it is not a complete parser for every tabular block of every EPA SWMM release.

## Errors and guarantees

- Invalid positional/numeric input -> `RangeError`, `TypeError` or `SyntaxError`, according to operation.
- Cache budget breaches -> `RangeError`. Existing cached columns remain intact.
- Automatic mode never silently rewrites the source, changes units, or introduces default values.
- `InpModel` does not interpret unrelated records while handling one `get` unless explicit materialization has been requested (or the auto threshold has been reached); auto only caches fixed-layout numeric columns.
- Build and test code is MIT, and no third-party model files are bundled in the published package.


For the current batch OUT query API, see [QUERY-ENGINE.md](QUERY-ENGINE.md). Independent numerical verification remains an open requirement; see [VERIFY-NATIVE.md](VERIFY-NATIVE.md).


## Optional OUT time-series index

`OutSeriesIndex` is a reusable min/max tree for **one** `SeriesRequest`. Build on first interest and serialize for repeat access. Request ranges are `[start, end)`. The index does not own or operate on a network API server.

```ts
const index = await OutSeriesIndex.build(out, {kind:'link',object:'C1',attribute:'flow'}, {
  sourceKey:contentSha256, maxIndexBytes:64 * 1024 * 1024,
  readOptions:{signal:controller.signal,maxReadBytes:2 * 1024 * 1024}
});
index.extrema(0,10000);       // {min,max,minPeriod,maxPeriod} or null
index.envelope(0,10000,1000); // SeriesEnvelope, no ByteSource.read
index.value(500);             // Float32 original value, including non-finite
const sidecar = index.serialize();
const reopened = OutSeriesIndex.restore(out,sidecar,{sourceKey:contentSha256,expectedRequest:index.request});
```

Memory grows as `32 * nextPowerOfTwo(periods)` **per channel**. See [INDEX-FORMAT.md](INDEX-FORMAT.md) for the binary index specification.

## Multi-channel query engine

The public API also exposes `OutReader.explainQuery()`, `query()`, `queryStream()` and `aggregateMany()`. These use a columnar `Float32Array`, allow arbitrary cross-kind requests, and support resource-bounded streaming. Full signatures, output layout, examples and planning contracts: [QUERY-ENGINE.md](QUERY-ENGINE.md). The canonical type definitions are in `dist/out.d.ts`.
