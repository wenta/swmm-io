# swmm-io

**Fast, dependency-free EPA SWMM file I/O for TypeScript.** Read and inspect `.inp`, `.out`, and `.rpt` in Node.js or modern browsers. Query large `.out` files without loading the entire result file into memory.

This package provides **parsing, indexing, validation, and result queries**. It is **not** a SWMM simulation engine, HTTP server, map renderer, or database.

## Install

The preview release is published under the `beta` dist-tag **only after a maintainer publishes it**:

```bash
npm install swmm-io@beta
```

To work on the source:

```bash
npm ci
npm run verify
```

Until the initial release is present in the registry, install the supplied tarball directly using `npm install ./swmm-io-0.8.0-beta.1.tgz`.

**Requirements:** Node.js 18+ for Node workloads; ES2022 and `Blob`/`ArrayBuffer` in browsers. ESM only. No runtime dependencies.

## Use it

### Read an `.inp` model

```ts
import { InpModel } from 'swmm-io';

const model = InpModel.parse(await inpFile.text());
const topology = model.topology();
const length = model.properties.get('CONDUITS', 'C1', 'length');
const diagnostics = model.validate({level:'full'});
const batch = model.properties.numericMany('CONDUITS', ['C1','C2'], ['length','roughness']);
```

INP input is preserved as text; schemas cover many common fixed and variant fields, but full SWMM semantic validation is not yet implemented. Large `.inp` files are still decoded to a JavaScript string.

### Query multiple `.out` channels

```ts
import { OutReader, BlobSource } from 'swmm-io';

const out = await OutReader.open(new BlobSource(outFile));

// Discover IDs and available result columns from the file, not from assumptions.
const linkIds = await out.ids('link');
const available = await out.columnNames('link');
const preferred = new Set(['flow', 'depth', 'velocity']);
const attributes = available
  .filter(column => preferred.has(column.name))
  .map(column => column.code); // numeric code works for all result columns

if (!linkIds.length || !attributes.length) throw new Error('No suitable link results');
const spec = {
  kind: 'link' as const,
  objects: linkIds.slice(0, 3),
  attributes,
  periods: { from: 0, to: Math.min(out.info.periods, 1000) }, // exclusive
};
const plan = await out.explainQuery(spec);
const result = await out.query(spec, { maxOutputBytes: 32 * 1024 * 1024 });

console.log(plan.strategy, plan.estimatedReadBytes);
console.log(result.requests, result.column(0)); // zero-copy view
```

`query()` returns **one series-major Float32Array**: each requested series is contiguous. The planner selects *sparse*, *grouped*, or *sequential* reads based on expected read calls, transferred bytes and a maximum over-read ratio. You can force a strategy for benchmarking. The `MemorySource` path bypasses I/O entirely.

For outputs that do not fit into memory, use the streaming and aggregation APIs (with `spec` defined as above):

```ts
for await (const chunk of out.queryStream(spec, {
  chunkPeriods: 256,
  maxOutputBytes: 8 * 1024 * 1024,
  maxReadBytes: 2 * 1024 * 1024,
  maxConcurrency: 8,
})) {
  processChunk(chunk.values, chunk.from, chunk.to);
}

const statistics = await out.aggregateMany(spec, {chunkPeriods: 256});
```

For mixed object kinds, supply `requests: [{kind:'node', object:'J1', attribute:'depth'}, ...]` instead of the `kind/objects/attributes` product. Request order and duplicate channels are preserved. `maxReadAmplification` (default `64`) limits unwanted over-reading by auto planning; a forced sequential strategy bypasses that heuristic.

### Local Node.js `.out` file

```bash
node examples/query-out.mjs /absolute/path/to/model.out
```

Node `FileHandleSource`, browser `BlobSource`, and `MemorySource` support positioned reads. Use `OutSeriesIndex` / `AdaptiveOutIndex` separately when you need repeated interactive chart queries to **one specific series**, rather than large multi-channel extraction.

## Performance model

| Workload | Recommended operation |
| --- | --- |
| A few scalar values | `out.value()` / `out.snapshotSelected()` |
| One frequently viewed chart | `out.seriesEnvelope()` or `AdaptiveOutIndex` |
| Hundreds to thousands of selected channels | `out.query()` |
| Very large time windows / bounded RAM | `out.queryStream()` |
| Min/max/mean across many channels | `out.aggregateMany()` |
| Selected INP columns | `model.properties.numericMany()` / `materialize()` |

Results are not universally faster. Reading sparsely selected channels may require many seeks, while reading the complete period records may transfer excess bytes. Benchmark on your storage and query shape; **`npm run bench:v08`** compares the new engine with `seriesMany()` on a synthetic fixture and reports actual read calls and bytes in an emulated source.

## Data discovery and compatibility

`ids('subcatch' | 'node' | 'link' | 'pollutant')` lists names embedded in the result file, while `columnNames('link')`, `columnNames('node')`, `columnNames('subcatch')` and `columnNames('system')` return the **actual variables present**, each as `{code, name}`. Use `code` directly in `query()`; descriptive names such as `pollutant:<name>` and `code<N>` are display labels, not necessarily valid string query aliases. Standard hydraulic variable names are accepted as strings. An `.inp` file is needed for complete network topology and coordinates.

This prerelease is suitable for evaluation, prototyping and controlled workflows. It is **not certified by EPA** and full parity with the native Output API, malformed-file security review and multi-GB performance validation remain unfinished. Runtime parsing and query processing do not require TypeScript at runtime.

## Testing and documentation

```bash
npm run verify
npm run bench:v08
node test/validate-real.mjs --download       # optional: downloads public fixtures
node test/validate-real.mjs --download --large
```

- [Documentation overview](docs/README.md)
- [Query engine API, layout and planning](docs/QUERY-ENGINE.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Performance and benchmark methodology](docs/PERFORMANCE.md)
- [Known compatibility limits](docs/COMPATIBILITY.md)
- [Security and untrusted-file limitations](docs/SECURITY.md)
- [Contributing and quality gates](docs/CONTRIBUTING.md)
- [Release and publishing guide](docs/RELEASING.md)
- [Release history](CHANGELOG.md)

**Correctness caveat:** full numerical parity with the official EPA SWMM Output API is not yet established for all supported formats and edge cases. Passing synthetic and real-file parsing tests is not a substitute for independent numerical validation. Test on known-good simulations before production use.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with, nor endorsed by, the US EPA.
