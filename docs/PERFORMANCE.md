# Performance methodology and representative results

The primary tuning variable for `.out` queries is not file size alone: it is **selected offsets × number of reporting periods × storage characteristics**.

## Reproduce

```bash
npm install
npm test
npm run bench:v08
# External fixture, if downloaded earlier:
node examples/query-out.mjs /absolute/path/to/model.out
```

`test/benchmark-v08.mjs` generates a synthetic 12,000-link/120-period `.out`, then requests three attributes across selections of 100, 1000 and 10,000 links. It compares the previous `seriesMany` implementation and the new `query` method using independent, counting ByteSource instances. Four runs are performed (one warmup, median of three); values are cross-checked.

The measured I/O counts describe *logical calls to ByteSource.read*, which can map to different syscalls in different implementations. Synthetic timings should not be presented as filesystem benchmarks.

## Resource behavior

- The one-shot `query()` output allocation is `4 × channels × periods` bytes (plus JS metadata).
- `queryStream()` keeps one chunk of output, the current read buffer(s) and metadata in memory; downstream consumers must release references to earlier chunks to maintain a bounded peak.
- `aggregateMany()` uses one streaming chunk plus O(channels) aggregation arrays.
- `MemorySource` retains the whole source supplied by the caller. `BlobSource` and `FileHandleSource` do not require the whole `.out` as a single JS buffer.
- The optional `OutSeriesIndex` stores per-channel min/max pyramids for charting; it is not needed to execute multi-channel queries.
- `maxReadBytes` limits each read call, **not** the total I/O across the query. The sequential plan may over-read to reduce call count.

## Regression and evidence

`docs/QUERY-ENGINE.md` describes exact layout and planner heuristics. Historical measurements are retained in `docs/history/` and the separate benchmark scripts under `test/`. Performance changes must compare the same fixture, source type, requested bytes, output parity, instrumentation and timing method. Where a new strategy is slower, document it rather than hiding that case.

**Open requirements:** independent numerical comparison against the official EPA SWMM Output API; real multi-GB file tests; Node/FileHandle and browser/Blob profiling at 100k–300k links; fair SSD/HTTP benchmarks with varied distance patterns; regression alerts across Node versions and CPU architectures.
