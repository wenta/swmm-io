/**
 * Repeatable synthetic query engine benchmarks.
 * Physical source is emulated in memory to count I/O calls/bytes. Timings are
 * NOT SSD measurements. Compare direct execution and results on same data.
 */
import { performance } from 'node:perf_hooks';
import { OutReader } from '../dist/index.js';
import { createPollutantOut } from './fixture-pollutants.mjs';

const linkCount=12000;
const periods=120;
const data=createPollutantOut({periods,paddingLinks:linkCount-1});
function counted() {
  const stats={calls:0,bytes:0,maxRead:0};
  const source={size:data.length,async read(at,n){stats.calls++;stats.bytes+=n;stats.maxRead=Math.max(stats.maxRead,n);return data.subarray(at,at+n)}};
  return {source,stats};
}
function median(x) {const a=x.slice().sort((x,y)=>x-y);return a[Math.floor(a.length/2)];}
function statsCopy(stats) {return {calls:stats.calls,bytes:stats.bytes,maxRead:stats.maxRead};}
function clear(stats) {stats.calls=0;stats.bytes=0;stats.maxRead=0;}
const scenarios = [
  {name:'sparse-100',links:100},
  {name:'grouped-1000',links:1000},
  {name:'dense-10000',links:10000}
];
const records=[];
for(const scenario of scenarios) {
  const selected=Array.from({length:scenario.links},(_,i)=>Math.floor(i*linkCount/scenario.links));
  const requests=selected.flatMap(object=>['flow','depth','velocity'].map(attribute=>({kind:'link',object,attribute})));
  const a=counted(),b=counted();
  const old=await OutReader.open(a.source);
  const next=await OutReader.open(b.source);
  const q={requests,periods:{from:0,to:periods}};
  const plan=await next.explainQuery(q);
  const oldTimes=[],newTimes=[];let oldIo,newIo;
  for(let rep=0;rep<4;rep++) {
    clear(a.stats);const t=performance.now();const series=await old.seriesMany(requests,0,periods);
    const d=performance.now()-t; if(rep>0)oldTimes.push(d);oldIo=statsCopy(a.stats);
    clear(b.stats);const x=performance.now();const block=await next.query(q);
    const nd=performance.now()-x;if(rep>0)newTimes.push(nd);newIo=statsCopy(b.stats);
    // Validate independent storage layouts for a selected sample of columns.
    for(const c of [0,requests.length>>1,requests.length-1]) {
      const col=block.column(c), expected=series[c];
      for(let j=0;j<periods;j++) if(!Object.is(col[j],expected[j])) throw Error(`Mismatch ${scenario.name} ${c} ${j}`);
    }
  }
  records.push({scenario:scenario.name,links:scenario.links,channels:requests.length,periods,
    values:periods*requests.length,plan,
    existingSeriesMany:{medianMs:+median(oldTimes).toFixed(3),io:oldIo},
    queryEngine:{medianMs:+median(newTimes).toFixed(3),io:newIo},
    speedup:+(median(oldTimes)/median(newTimes)).toFixed(2)});
  console.error('Finished',scenario.name);
}
const report={node:process.version,platform:process.platform,arch:process.arch,model:'synthetic SWMM 5.2 fixture',fileBytes:data.byteLength,
  methodology:'Four sequential reps (one warmup, median of 3), in-memory counting ByteSource; no SSD or network I/O',records};
console.log(JSON.stringify(report,null,2));
