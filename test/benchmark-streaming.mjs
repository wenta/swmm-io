/** Repeatable local microbenchmark, synthetic EPA-layout fixture. Not SWMM engine output. */
import { performance } from 'node:perf_hooks';
import { OutReader, MemorySource, BlobSource } from '../dist/index.js';
import { createPollutantOut } from './fixture-pollutants.mjs';

const periods = Number(process.argv[2] ?? 100_000);
if (!Number.isSafeInteger(periods) || periods < 10 || periods > 2_000_000) throw new Error('Invalid period count');
const bytes = createPollutantOut({ periods });
const fmt = ms => `${ms.toFixed(2)} ms`;
console.log(`Synthetic EPA-layout OUT: ${(bytes.length/1048576).toFixed(1)} MiB, ${periods} reporting periods`);
for (const [kind, source] of [['MemorySource',new MemorySource(bytes)],['BlobSource',new BlobSource(new Blob([bytes]))]]) {
  const out = await OutReader.open(source);
  // JIT warmup with a short query, independent of the recorded measurements.
  await out.series('link', 'L1', 'flow', 0,Math.min(1000, periods));
  const t0 = performance.now();
  const full = await out.series('link','L1','flow');
  const t1 = performance.now();
  const envelope = await out.seriesEnvelope('link','L1','flow',0,periods,1000);
  const t2 = performance.now();
  const stats = await out.seriesStatistics('link','L1','flow');
  const t3 = performance.now();
  if (full.length !== periods || envelope.values.length > 1000 || stats.finiteCount !== periods) {
    throw new Error('Benchmark output failed sanity checks');
  }
  console.log(`${kind}: full series ${fmt(t1-t0)} (${full.length} Float32); envelope ${fmt(t2-t1)} (${envelope.values.length} points); streaming stats ${fmt(t3-t2)} (mean=${stats.mean.toFixed(2)})`);
}
