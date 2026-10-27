/**
 * Real public API benchmark of the hybrid column cache (no private prototypes).
 * Each strategy runs in a fresh Node process for memory isolation. The fixture
 * is deterministic synthetic SWMM CONDUITS and thus measures parser mechanics,
 * not hydraulic engine execution. Always validate query checksums.
 *
 * Usage:
 *   npm run bench:cache
 *   node --expose-gc test/benchmark-cache.mjs --quick
 */
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { InpModel } from '../dist/index.js';

function input(n) {
  const rows = new Array(n + 1);
  rows[0] = '[CONDUITS]\n';
  for (let i = 0; i < n; i++) rows[i+1] = `C${i} J${i} J${i+1} ${100 + i % 300} 0.013 ${i%8} ${i%11} 0 0\n`;
  return rows.join('');
}
function measure(fn,trials=5) {
  const times=[];let check;
  for(let i=0;i<trials;i++) {
    const start=performance.now();const x=fn();times.push(performance.now()-start);
    if(check!==undefined && Math.abs(x-check)>0.001)throw Error('Nondeterministic checksum');
    check=x;
  }
  times.sort((a,b)=>a-b);
  return {medianMs: +(times[Math.floor(times.length/2)]).toFixed(3),checksum:check};
}
function memory() {
  global.gc?.();const m=process.memoryUsage();
  return {heapMiB:+(m.heapUsed/1048576).toFixed(3),arrayBuffersMiB:+(m.arrayBuffers/1048576).toFixed(3),rssMiB:+(m.rss/1048576).toFixed(3)};
}
function worker(n, strategy, hits){
  const text=input(n);
  const t0=performance.now();
  const model=InpModel.parse(text, strategy==='auto'
    ? {mode:'auto',maxBytes:64*1024*1024,minPromotionReads:256,promotionRatio:0.001}
    : {maxBytes:64*1024*1024});
  const parseMs=performance.now()-t0;
  model.properties.get('CONDUITS','C0','length'); // build identical shared ID index
  const baseline=memory();
  const start=performance.now();
  if(strategy==='manual') model.properties.materialize('CONDUITS',['length','roughness','inletOffset','outletOffset']);
  if(strategy==='auto') {
    // The first field reaches promotionThreshold through actual calls. In a
    // real application other fields would each promote on independent demand.
    const hotCount=Math.max(256,Math.ceil(n*0.001));
    for(let j=0;j<hotCount;j++)model.properties.get('CONDUITS','C1','length');
    model.properties.materialize('CONDUITS',['roughness','inletOffset','outletOffset']);
  }
  const setupMs=performance.now()-start;
  const afterBuild=memory();
  const ids=Array.from({length:hits},(_,i)=>'C'+((i*9973)%n));
  const q=()=>{let sum=0;for(const id of ids){
    sum+=Number(model.properties.get('CONDUITS',id,'length'));
    sum+=Number(model.properties.get('CONDUITS',id,'roughness'));
    sum+=Number(model.properties.get('CONDUITS',id,'inletOffset'));
    sum+=Number(model.properties.get('CONDUITS',id,'outletOffset'));
  }return sum};
  const expected=ids.reduce((sum,id)=>{const v=Number(id.slice(1));return sum+100+(v%300)+0.013+(v%8)+(v%11);},0);
  const result=measure(q,n>=1000000?3:5);
  if(Math.abs(result.checksum-expected)>0.001)throw Error(`Checksum mismatch ${result.checksum} vs ${expected}`);
  return {n,strategy,requests:hits,propertiesPerRequest:4,textBytes:Buffer.byteLength(text),parseMs:+parseMs.toFixed(3),setupMs:+setupMs.toFixed(3),queryMedianMs:result.medianMs,checksum:result.checksum,
    addedHeapMiB:+(afterBuild.heapMiB-baseline.heapMiB).toFixed(3),addedArrayBuffersMiB:+(afterBuild.arrayBuffersMiB-baseline.arrayBuffersMiB).toFixed(3),cache:model.properties.cacheStats(),node:process.version};
}
if(process.argv[2]==='--worker') {
  console.log(JSON.stringify(worker(Number(process.argv[3]),process.argv[4],Number(process.argv[5]))));
} else {
  const quick=process.argv.includes('--quick');
  const sizes=quick?[10000,100000]:[10000,100000,300000,1000000];
  const calls=quick?10000:50000;
  const cases=[];
  for(const n of sizes)for(const strategy of ['lazy','manual','auto']) {
    const command=[process.execPath,'--expose-gc',fileURLToPath(import.meta.url),'--worker',String(n),strategy,String(calls)];
    const data=JSON.parse(execFileSync(command[0],command.slice(1),{encoding:'utf8',timeout:180000}));
    cases.push(data);
    console.error(`${n} ${strategy}: setup ${data.setupMs}ms, queries ${data.queryMedianMs}ms, payload ${data.cache.usedBytes} B`);
  }
  const output={generatedAt:new Date().toISOString(),node:process.version,cpu:os.cpus()[0]?.model,platform:process.platform,
    methodology:'Independent process per fixture/strategy; 5 repeated trials (3 for 1M), median query execution; setup and memory measurements separate; synthetic CONDUITS; checksums verified; auto mode uses experimentally low threshold to demonstrate promotion.',cases};
  const destination=new URL('../benchmarks/cache-v0.5.0-results.json', import.meta.url);
  writeFileSync(destination,JSON.stringify(output,null,2)+'\n');
  console.log(fileURLToPath(destination));
}
