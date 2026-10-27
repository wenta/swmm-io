# Multi-channel `.out` query engine

## Scope

`OutReader` retains its existing `value()`, `series()`, `seriesMany()`, `snapshotSelected()`, and `seriesEnvelope()` APIs. Additional operations optimize **multi-channel bulk extraction**, not individual-chart indexing:

- `explainQuery(spec, options?)`: resolve IDs and attributes, estimate I/O without reading values
- `query(spec, options?)`: one bounded columnar result
- `queryStream(spec, options?)`: async iterator with backpressure, limited output buffers
- `aggregateMany(spec, options?)`: streaming per-channel min/max/mean with non-finite counts

API is independent of HTTP and Node.js built-ins. File `source.read()` is the only physical read dependency.

## Query specification

A query accepts either a Cartesian product of objects and attributes:

```ts
const spec = {
  kind: 'link' as const,
  objects: ['C1','C2','C3'],
  attributes: ['flow','depth','velocity'],
  periods: {from: 100, to: 200}, // [100,200)
  strategy: 'auto' as const,
  maxReadAmplification: 64,
};
```

Or arbitrary channels across types, e.g. `requests: [{kind:'node',object:'J1',attribute:'depth'}, {kind:'link',object:'C2',attribute:'flow'}]`. Do not supply both forms at once. Period indexes are **zero based**, `to` is **exclusive**, and output order (including duplicates) is stable. Values are `Float32` as stored in `.out`; the library does not convert units implicitly.

## Output layout

`query()` produces an `OutQueryChunk`:

```ts
{
  from: 100, to: 200, requests: [...],
  seriesCount: 9, periodCount: 100,
  layout: 'series-major',
  values: Float32Array(900),
  column(index: number): Float32Array
}
```

`column(i)` is a **view** of `values`, not a copy. Don't mutate the returned view unless you intend to alter the result. For `n` periods: sample `(seriesIndex, periodIndex)` is at `values[seriesIndex*n + periodIndex]`.

`query()` allocates the entire result as one array, with the default maximum **256 MiB**. Supply `maxMemoryBytes` on the spec or `maxOutputBytes` in options to lower the limit. If the result exceeds that limit, use `queryStream()`.

## How planning works

The `.out` time-series area is period-major: each period record contains contiguous variables for all objects. The planner resolves object IDs once and computes byte offsets. It then estimates:

| Plan | Actual behavior | Typical use |
| --- | --- | --- |
| `sparse` | 4-byte reads for individual unique physical columns per period | A handful of distant channels |
| `grouped` | Coalesce nearby channel offsets within one period; cap buffer size and concurrent reads | Modest selected subsets |
| `sequential` | One contiguous span across successive period records, split into `maxReadBytes`-bounded chunks | Dense selections where avoiding syscalls outweighs over-reading |
| `memory` | Direct `DataView.getFloat32` without source I/O | In-memory source |

For file-backed data, auto compares `estimatedReadBytes + estimatedReadCalls * 16 KiB` (a heuristic cost proxy). To prevent surprising full-file reads for a few distant channels, **sequential is disallowed in auto mode when its read amplification exceeds 64× the grouped read volume**. The ratio is adjustable via `maxReadAmplification`. This is a heuristic, not hardware calibration; forcibly select `strategy` to validate on your storage. `explainQuery()` exposes estimated calls, bytes, grouping and strategy.

In all strategies, transient source reads are bounded by `maxReadBytes` (default 2 MiB); source read concurrency is bounded by `maxConcurrency` (default 16). Neither bound applies to the source's own external caching implementation. A caller may provide `AbortSignal`; cancellation is cooperative between reads and before decoding a response.

## Streaming and aggregation

```ts
for await (const part of reader.queryStream(spec, {
  chunkPeriods: 1024,
  maxOutputBytes: 16 * 1024 * 1024,
  signal: abortController.signal,
})) {
  consume(part.column(0));
}

const agg=await reader.aggregateMany(spec, {chunkPeriods:1024});
// agg.min, agg.max, agg.mean: Float64Array
// agg.finiteCount, agg.nonFiniteCount: Uint32Array
```

The iterator yields a fresh result per chunk and waits for the consumer before reading further (backpressure). For a wide query, `chunkPeriods` is reduced automatically to satisfy the output-byte budget. Aggregation uses compensated summation. Non-finite values are excluded from min/max/mean and included in `nonFiniteCount`; an all-non-finite column yields NaN. Aggregation still scans the selected values; it is not an indexed query.

## What is *not* optimized yet

- No persistent columnar copy or global query-cache of `.out` values.
- No merging concurrent, independent user requests to the same byte range.
- No conversion to vector tiles or GeoJSON: responsibilities of consumers, not an I/O parser.
- No server authorization, job queue, database, or HTTP client.
- No promise of universal speedup. Very sparse plans can be seek-bound, and dense decoding may be CPU-bound. Profile separately.

## Benchmark and verification

Run `npm run bench:v08`. The benchmark compares selected channel sets of 100, 1000 and 10,000 links against existing `seriesMany()`, using the **same synthetic binary fixture** and the same requested values. It measures a source whose reads are implemented as in-memory byte-array slices, so it demonstrates algorithm/call-volume effects, **not actual SSD, HTTP, or object-storage latency**. Always inspect both elapsed time and `io.calls`/`io.bytes`. For a given output, correctness tests compare the returned arrays exactly with `seriesMany()` including duplicated channels and pollutant variables.
