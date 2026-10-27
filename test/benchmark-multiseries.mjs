/** Reproducible demonstration, not a certified performance comparison. */
import { performance } from 'node:perf_hooks';
import { OutReader, MemorySource } from '../dist/index.js';
import { createPollutantOut } from './fixture-pollutants.mjs';

const data = createPollutantOut({periods:3000, paddingLinks:200});
const memory = await OutReader.open(new MemorySource(data));
const request = [
  {kind:'link',object:'L1',attribute:'flow'},
  {kind:'link',object:'D40',attribute:'flow'},
  {kind:'link',object:'D100',attribute:'depth'},
  {kind:'link',object:'D199',attribute:'velocity'},
  {kind:'node',object:'J1',attribute:'depth'},
  {kind:'node',object:'J2',attribute:'head'}
];
function countingSource() {
  const stats = {reads:0, bytes:0};
  const source = {
    size: data.length,
    async read(offset,length) {
      stats.reads++; stats.bytes+=length;
      return data.subarray(offset,offset+length);
    }
  };
  return {source,stats};
}
async function once(reader,batched) {
  if (batched) return reader.seriesMany(request);
  const result = [];
  for (const r of request) result.push(await reader.series(r.kind,r.object,r.attribute));
  return result;
}
function median(items) { return items.slice().sort((a,b)=>a-b)[Math.floor(items.length/2)]; }
async function trial(reader,batched) {
  // Warm JIT and cached object indexes; timing excludes file open/index setup.
  for (let i=0;i<4;i++) await once(reader,batched);
  const timings=[];
  for(let i=0;i<12;i++) {
    const t=performance.now();
    const result=await once(reader,batched);
    if (result[0][0] !== 0) throw Error('Benchmark data corrupted');
    timings.push(performance.now()-t);
  }
  return Math.round(median(timings)*100)/100;
}

const memSeparate = await trial(memory,false);
const memBatch = await trial(memory,true);
const singles = countingSource();
const singlesReader = await OutReader.open(singles.source);
await once(singlesReader,false);
const ioSeparate = { ...singles.stats };
const batched = countingSource();
const batchedReader = await OutReader.open(batched.source);
await once(batchedReader,true);
const ioBatch = { ...batched.stats };
console.log(JSON.stringify({ node: process.version, kind:'synthetic', bytes: data.length,
  periods:3000, series:request.length,
  memoryMedianMs: { separate: memSeparate, batch: memBatch },
  io: {separate:ioSeparate, batched:ioBatch} },null,2));
