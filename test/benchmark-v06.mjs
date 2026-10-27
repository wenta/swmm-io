#!/usr/bin/env node
/**
 * Reproducible workload benchmark. Not a native EPA SWMM comparison.
 * Run with `node --expose-gc test/benchmark-v06.mjs [--large]`.
 * Prints JSON only; captures CPU / Node version to aid reproducibility.
 */
import { InpModel, OutReader, MemorySource, BlobSource } from '../dist/index.js';
import { createOut } from './fixture.mjs';
import { performance } from 'node:perf_hooks';
import { cpus, platform, arch } from 'node:os';
const sizes = process.argv.includes('--large') ? [10000,100000,300000] : [10000,100000];
const readings = 10000;
const fieldNames=['length','roughness','inletOffset','outletOffset'];
function median(values) {return [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];}
function measure(run) {const samples=[];let checksum=0;for(let i=0;i<5;i++){const t=performance.now();checksum+=run();samples.push(performance.now()-t)}return{ms:median(samples.slice(1)),checksum,samples};}
const report={node:process.version,platform:platform(),arch:arch(),cpu:cpus()[0]?.model, timestamp:new Date().toISOString(),large:process.argv.includes('--large'),sizes:[]};
for(const n of sizes){
 const lines=new Array(n+1);lines[0]='[CONDUITS]';
 for(let i=0;i<n;i++)lines[i+1]=`C${i} N${i} N${i+1} ${i%800+10} 0.013 0 0`;
 const text=lines.join('\n');
 const t0=performance.now();const model=InpModel.parse(text);const parseMs=performance.now()-t0;
 const p=model.properties;
 const ids=Array.from({length:readings},(_,i)=>`C${(i*37)%n}`);
 // Pre-warm the ID index and key maps, EXCLUDING column materialization.
 p.get('CONDUITS','C0','length');
 const memBefore=process.memoryUsage();
 const lazy=measure(()=>{let sum=0;for(const id of ids)for(const field of fieldNames)sum+=p.get('CONDUITS',id,field);return sum;});
 const batch=measure(()=>{let sum=0;for(const row of p.getMany('CONDUITS',ids,fieldNames).rows)for(const v of row)sum+=v;return sum;});
 const numeric=measure(()=>{let sum=0;for(const col of p.numericMany('CONDUITS',ids,fieldNames).columns)for(const v of col)sum+=v;return sum;});
 const startCache=performance.now();p.materialize('CONDUITS',fieldNames);const buildMs=performance.now()-startCache;
 const cached=measure(()=>{let sum=0;for(const col of p.numericMany('CONDUITS',ids,fieldNames).columns)for(const v of col)sum+=v;return sum;});
 const memAfter=process.memoryUsage();
 for(const m of [lazy,batch,numeric,cached])if(Math.abs(m.checksum-lazy.checksum)>1e-6*Math.max(1,Math.abs(lazy.checksum)))throw Error(`Checksum mismatch ${m.checksum} vs ${lazy.checksum}`);
 report.sizes.push({rows:n,sourceBytes:text.length,parseMs,idReads:readings,fields:fieldNames.length,
   lazyMs:lazy.ms,batchMs:batch.ms,numericMs:numeric.ms,materializeMs:buildMs,cachedNumericMs:cached.ms,
   cacheBytes:p.cacheStats().usedBytes,heapDeltaBytes:memAfter.heapUsed-memBefore.heapUsed,
   checksum:lazy.checksum});
 console.error(`Finished ${n} rows`);
}
// Real parser + synthetic output, Blob forces true async I/O and avoids memory fast path.
const bytes=createOut(50000);
const out=await OutReader.open(new BlobSource(new Blob([bytes])));
const start=performance.now();const selected=await out.snapshotSelected('node','depth',49_999,['J2','J1','J2']);
const selectionMs=performance.now()-start;
const sparseBegin=performance.now();const both=await out.seriesMany([
 {kind:'node',object:'J1',attribute:'depth'}, {kind:'link',object:'C1',attribute:'flow'}
],0,300,'sparse');const sparseMs=performance.now()-sparseBegin;
report.output={bytes:bytes.length,periods:out.info.periods,selectionMs,sparseMs,values:[...selected.values],seriesLength:both[0].length};
console.log(JSON.stringify(report,null,2));
