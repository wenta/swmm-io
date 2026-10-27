import {performance} from 'node:perf_hooks';
import {OutReader, OutSeriesIndex, OutIndexCache, AdaptiveOutIndex, MemorySource} from '../dist/index.js';
import {createOut} from './fixture.mjs';

const req={kind:'link',object:'C1',attribute:'flow'};
const round=n=>Math.round(n*1000)/1000;
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const sizes=process.argv.includes('--large')?[50_000,250_000]:[5_000,50_000];
const results=[];
for(const periods of sizes){
  const bytes=createOut(periods);
  const out=await OutReader.open(new MemorySource(bytes));
  const windows=Array.from({length:30},(_,i)=>{
    const start=Math.floor(i*(periods-200)/30), end=Math.min(periods,start+Math.max(1000,Math.floor(periods*0.48)));
    return [start,end];
  });
  const direct=[];
  for(let repeat=0;repeat<5;repeat++){
    let n=0;const t=performance.now();
    for(const [start,end] of windows){ const v=await out.seriesEnvelope(req.kind,req.object,req.attribute,start,end,300);n+=v.values.length; }
    direct.push(performance.now()-t);
    if(n===0)throw Error('empty result');
  }
  const cache=new OutIndexCache({maxBytes:OutIndexCache.requiredBytes(periods)});
  const builtAt=performance.now();
  const index=await cache.getOrBuild(out,req,'sha256:bench');
  const buildMs=performance.now()-builtAt;
  const indexed=[];
  for(let repeat=0;repeat<5;repeat++){
    const t=performance.now();
    for(const [start,end] of windows)index.envelope(start,end,300);
    indexed.push(performance.now()-t);
  }
  const adaptiveCache=new OutIndexCache({maxBytes:index.indexBytes});
  const adaptive=new AdaptiveOutIndex(adaptiveCache,{promoteAfterQueries:3,minAverageDirectMs:0,minPeriods:1});
  const modes=[];
  const tAuto=performance.now();
  for(const [start,end] of windows){const result=await adaptive.envelope(out,req,'sha256:bench',start,end,300);modes.push(result.mode);}
  const autoMs=performance.now()-tAuto;
  const memory=process.memoryUsage();
  results.push({periods,sourceBytes:bytes.length,indexBytes:index.indexBytes,
    direct30MedianMs:round(median(direct)),cached30MedianMs:round(median(indexed)),
    speedup:round(median(direct)/median(indexed)),buildMs:round(buildMs),
    adaptive30Ms:round(autoMs),adaptiveDirectQueries:modes.filter(x=>x==='direct').length,
    adaptiveIndexedQueries:modes.filter(x=>x==='indexed').length,
    cacheStats:cache.stats(),memory:{rss:memory.rss,arrayBuffers:memory.arrayBuffers}});
  if(global.gc)global.gc();
}
console.log(JSON.stringify({runtime:process.version,platform:process.platform,arch:process.arch,results},null,2));
