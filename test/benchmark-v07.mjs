import { performance } from 'node:perf_hooks';
import { OutReader, OutSeriesIndex, MemorySource, BlobSource } from '../dist/index.js';
import { createOut } from './fixture.mjs';

// A reproducible synthetic throughput benchmark, NOT an official EPA parity test.
// By design, the cached index returns identical data for all repeated queries.
const large=process.argv.includes('--large');
const periods=large ? 250_000 : 50_000;
const nQueries=large ? 10 : 30;
const input=createOut(periods);
const req={kind:'link',object:'C1',attribute:'flow'};
const source= new BlobSource(new Blob([input]));
const out=await OutReader.open(source);
const key='benchmark:synthetic:immutable';
const sizes=[1000,500,1500,2000,4000];
const ranges=Array.from({length:nQueries},(_,i)=>({
  start:Math.floor((i % 7) * periods / 30),
  end:periods-Math.floor((i%9) * periods / 31),
  max:sizes[i % sizes.length]
}));
const timings={};
async function run(label,callback) {
  const before=performance.now();
  const value=await callback();
  timings[label]=Math.round((performance.now()-before)*1000)/1000;
  return value;
}
const snapshot=()=>{const m=process.memoryUsage();return {rss:m.rss,heapUsed:m.heapUsed,arrayBuffers:m.arrayBuffers};};
global.gc?.();
const baseline=snapshot();
const index=await run('indexBuildMs',()=>OutSeriesIndex.build(out,req,{sourceKey:key,chunkPeriods:4096}));
global.gc?.();const afterIndex=snapshot();
const indexBytes=index.indexBytes;
const saved=await run('serializeMs',async()=>index.serialize());
const loaded=await run('restoreMs',async()=>OutSeriesIndex.restore(out,saved,{sourceKey:key}));
// Warm both paths, so startup/deferred ID decoding is excluded from loop.
await out.seriesEnvelope('link','C1','flow',0,periods,1000);
loaded.envelope(0,periods,1000);
let checksumRaw=0,checksumIndex=0;
const runs=large ? 2 : 3;
const rawSamples=[],indexSamples=[];
for(let run=0;run<runs;run++) {
  let checkR=0,checkI=0;
  let before=performance.now();
  for(const r of ranges){const v=await out.seriesEnvelope('link','C1','flow',r.start,r.end,r.max);
    checkR+=v.values.length;}
  rawSamples.push(Math.round((performance.now()-before)*1000)/1000);
  before=performance.now();
  for(const r of ranges){const v=loaded.envelope(r.start,r.end,r.max);
    checkI+=v.values.length;}
  indexSamples.push(Math.round((performance.now()-before)*1000)/1000);
  if(checkI!==checkR)throw new Error('Different point counts');
  checksumRaw=checkR;checksumIndex=checkI;
}
function median(arr){const sorted=arr.slice().sort((a,b)=>a-b);const middle=Math.floor(sorted.length/2);return sorted.length%2?sorted[middle]:(sorted[middle-1]+sorted[middle])/2;}
timings.rawRepeatedMedianMs=median(rawSamples);
timings.indexedRepeatedMedianMs=median(indexSamples);
if(checksumRaw!==checksumIndex)throw new Error('Output point counts changed');
const beforeRead=await out.seriesEnvelope('link','C1','flow',0,periods,1234);
const afterRead=loaded.envelope(0,periods,1234);
if(beforeRead.values.length!==afterRead.values.length||beforeRead.values.some((v,i)=>!Object.is(v,afterRead.values[i])))
  throw new Error('Indexed chart values differ from raw chart');
console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,periods,
  inputBytes:input.byteLength,queries:nQueries,indexBytes,persistedBytes:saved.length,
  timings,rawSamples,indexSamples,baseline,afterIndex,checksumRaw,checksumIndex},null,2));
