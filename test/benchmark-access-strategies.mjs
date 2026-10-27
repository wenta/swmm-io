/**
 * apples-to-apples indexed-on-demand vs eager column store.
 * `node --expose-gc test/benchmark-access-strategies.mjs --worker 100000 index 4`
 * Parent mode invokes each benchmark in a fresh process for isolated GC/memory.
 */
import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { InpModel } from '../dist/index.js';

function median(a){const x=[...a].sort((a,b)=>a-b);return x[Math.floor(x.length/2)];}
function round(n){return +n.toFixed(3)}
function mem(){global.gc?.();const m=process.memoryUsage();return {heapMiB:round(m.heapUsed/1048576),arrayBuffersMiB:round(m.arrayBuffers/1048576),rssMiB:round(m.rss/1048576)};}
function measure(fn,n=7){const t=[];let v;for(let i=0;i<n;i++){const s=performance.now();v=fn();t.push(performance.now()-s);}return {medianMs:round(median(t)),minMs:round(Math.min(...t)),maxMs:round(Math.max(...t)),result:v};}
function input(n){const rows=new Array(n+1);rows[0]='[CONDUITS]\n';for(let i=0;i<n;i++)rows[i+1]=`C${i} J${i} J${i+1} ${100+i%300} 0.013 ${i%8} ${i%11} ${i%17} 0\n`;return rows.join('');}
const fields=['length','roughness','inletOffset','outletOffset'];
function eagerColumnar(model,n,count){const arrays=Array.from({length:count},()=>new Float64Array(n));const ids=new Map();let at=0;for(const row of model.document.rows('CONDUITS')){const id=row.fields[0];if(!id)continue;ids.set(id,at);for(let k=0;k<count;k++)arrays[k][at]=Number(row.fields[k+3]);at++}if(at!==n)throw Error('Eager row count mismatch');return {ids,arrays};}
function fastColumnar(source,n,count){
 // Lightweight single-pass scanner optimized for fixed-layout whitespace-delimited
 // CONDUITS. This is a benchmark prototype; it is NOT a general SWMM lexer.
 const arrays=Array.from({length:count},()=>new Float64Array(n));const ids=new Map();
 let at=0,offset=source.indexOf('\n')+1;
 while(offset<source.length){let end=source.indexOf('\n',offset);if(end===-1)end=source.length;let pos=offset,field=0,id='';
   while(pos<end&&field<3+count){while(pos<end&&(source.charCodeAt(pos)===32||source.charCodeAt(pos)===9||source.charCodeAt(pos)===13))pos++;if(pos===end||source.charCodeAt(pos)===59)break;
     const start=pos;while(pos<end&&source.charCodeAt(pos)!==32&&source.charCodeAt(pos)!==9&&source.charCodeAt(pos)!==13&&source.charCodeAt(pos)!==59)pos++;
     if(field===0)id=source.slice(start,pos);
     else if(field>=3)arrays[field-3][at]=Number(source.slice(start,pos));field++;
   }
   if(id){ids.set(id,at);at++;}
   offset=end+1;
 }
 if(at!==n)throw Error('Fast columnar row count mismatch');return {ids,arrays};
}
function singleQuery(model,id){return model.properties.get('CONDUITS',id,'length');}
function multiQuery(model,id){return Number(model.properties.get('CONDUITS',id,'length'))+Number(model.properties.get('CONDUITS',id,'roughness'))+Number(model.properties.get('CONDUITS',id,'inletOffset'))+Number(model.properties.get('CONDUITS',id,'outletOffset'));}
function runWorker(n,strategy,count){
 const text=input(n);const textBytes=Buffer.byteLength(text);const s=performance.now();const model=InpModel.parse(text);const parseMs=round(performance.now()-s);const parsedMemory=mem();
 let data;
 const start=performance.now();
 if(strategy==='index'){
  singleQuery(model,'C0');data=null;
 }else if(strategy==='rows') data=eagerColumnar(model,n,count);
 else if(strategy==='fast') data=fastColumnar(text,n,count);
 else throw Error('Unknown strategy');
 const buildMs=round(performance.now()-start),builtMemory=mem();
 const ids=Array.from({length:50000},(_,i)=>'C'+((i*9973)%n));
 const expectedOne=ids.reduce((sum,id)=>sum+100+(Number(id.slice(1))%300),0);
 const getOne=strategy==='index'?(id)=>Number(singleQuery(model,id)):(id)=>data.arrays[0][data.ids.get(id)];
 const qOne=measure(()=>{let sum=0;for(const id of ids)sum+=getOne(id);return sum;},n>=1000000?5:7);
 if(qOne.result!==expectedOne)throw Error(`Single-property mismatch ${qOne.result} != ${expectedOne}`);
 let qFour=null;
 if(count===4){
   const getFour=strategy==='index'?(id)=>multiQuery(model,id):(id)=>{const p=data.ids.get(id),a=data.arrays;return a[0][p]+a[1][p]+a[2][p]+a[3][p]};
   // Compare 4 properties: sum matches for index/columnar.
   qFour=measure(()=>{let sum=0;for(const id of ids)sum+=getFour(id);return sum;},n>=1000000?5:7);
   const expectedFour=ids.reduce((sum,id)=>{const v=Number(id.slice(1));return sum+100+(v%300)+0.013+(v%8)+(v%11);},0);
   if(Math.abs(qFour.result-expectedFour)>0.001)throw Error('Four-property checksum mismatch');
 }
 const bulkIndexed=strategy==='index'?measure(()=>{const col=model.properties.numericColumn('CONDUITS','length');let sum=0;for(const value of col.values)sum+=value;return sum},n>=1000000?2:4):null;
 let bulkCached=null;
 if(strategy!=='index')bulkCached=measure(()=>{let sum=0;for(const value of data.arrays[0])sum+=value;return sum});
 if(bulkCached){const expectedBulk=n*100+Math.floor(n/300)*44850+((n%300)*((n%300)-1)/2);if(Math.abs(bulkCached.result-expectedBulk)>0.001)throw Error('Bulk checksums differ');}
 const afterQueries=mem();
 return {n,strategy,columns:count,textBytes,runtime:process.version,parseMs,buildMs,parsedMemory,builtMemory,afterQueries,
  qOne:{medianMs:qOne.medianMs,minMs:qOne.minMs,maxMs:qOne.maxMs,checksum:qOne.result,operations:ids.length},
  qFour:qFour?{medianMs:qFour.medianMs,minMs:qFour.minMs,maxMs:qFour.maxMs,checksum:qFour.result,operations:ids.length}:null,
  bulkIndexed:bulkIndexed?{medianMs:bulkIndexed.medianMs,checksum:bulkIndexed.result}:null,bulkCached:bulkCached?{medianMs:bulkCached.medianMs,checksum:bulkCached.result}:null};
}
if(process.argv[2]==='--worker'){
 const n=Number(process.argv[3]),strategy=process.argv[4],count=Number(process.argv[5]);
 console.log(JSON.stringify(runWorker(n,strategy,count)));
}else{
 const sizes=process.argv.includes('--quick')?[10000,100000]:[10000,100000,300000,1000000];
 const script=fileURLToPath(import.meta.url),scenarios=[];
 for(const n of sizes)for(const strategy of ['index','rows','fast'])for(const count of [1,4]){
   const result=JSON.parse(execFileSync(process.execPath,['--expose-gc',script,'--worker',String(n),strategy,String(count)],{encoding:'utf8',maxBuffer:1024*1024,timeout:120000}));
   scenarios.push(result);
   console.error(`${n} ${strategy} ${count} build ${result.buildMs}ms, one ${result.qOne.medianMs}ms, four ${result.qFour?.medianMs??'—'}ms, mem +${round(result.builtMemory.heapMiB-result.parsedMemory.heapMiB)}MiB heap`);
 }
 const output={createdAt:new Date().toISOString(),platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,node:process.version,method:'Single isolated Node process per strategy and size; median of seven repeated query trials (five for 1,000,000 rows); numeric checksums verified.',scenarios};
 const outputFile=new URL('../benchmarks/access-strategies-results.json',import.meta.url);
 writeFileSync(outputFile,JSON.stringify(output,null,2)+'\n');console.log(JSON.stringify({path:fileURLToPath(outputFile),count:scenarios.length}));
}
