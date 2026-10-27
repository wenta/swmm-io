import { performance } from 'node:perf_hooks';
import { InpDocument, InpModel, OutReader, MemorySource } from '../dist/index.js';
import { createPollutantOut } from './fixture-pollutants.mjs';

const count=100_000;
let parts=['[CONDUITS]\n'];
for(let i=0;i<count;i++)parts.push(`C${i} J${i} J${i+1} ${100+i%300} 0.013 0 0 0 0\n`);
const text=parts.join(''); parts=[];
function timing(fn){const t=performance.now();const result=fn();return [+(performance.now()-t).toFixed(2),result]}
function memory(){if(global.gc)global.gc();return +(process.memoryUsage().heapUsed/2**20).toFixed(2)}
const baseline=memory();
const [openMs,doc]=timing(()=>InpDocument.parse(text));
const model=new InpModel(doc);
const indexedBefore=memory();
const [firstMs,first]=timing(()=>model.properties.get('CONDUITS','C99999','length'));
const afterIndex=memory();
const [lookupsMs,lookupSum]=timing(()=>{let sum=0;for(let i=0;i<50_000;i++)sum+=model.properties.get('CONDUITS',`C${(i*65537)%count}`,'length');return sum});
const [columnMs,column]=timing(()=>model.properties.numericColumn('CONDUITS','length'));
const [baselineColumnMs,baselineColumn]=timing(()=>{const ids=[],values=[];for(const row of doc.rows('CONDUITS')){ids.push(row.fields[0]);values.push(Number(row.fields[3]));}return{ids,values}});
const afterAll=memory();
if(first!==199||column.values.length!==count||baselineColumn.values.length!==count||Math.abs(lookupSum)<1)throw Error('benchmark correctness failure');
const out=await OutReader.open(new MemorySource(createPollutantOut({periods:2})));
const link=await out.properties('link');
const [namedReadsMs,sum]=timing(()=>{let sum=0;for(let i=0;i<1_000_000;i++)sum+=link.getNamed(0,'length');return sum});
if(sum!==50_000_000)throw Error('property sum mismatch');
console.log(JSON.stringify({runtime:process.version,model:{rows:count,bytes:Buffer.byteLength(text)},
  timesMs:{indexSections:openMs,firstIndexedLookupAndBuild:firstMs,fiftyThousandIndexedLookups:lookupsMs,optimizedNumericColumn:columnMs,baselineAllFieldsColumn:baselineColumnMs,millionNamedOutReads:namedReadsMs},
  heapMiB:{before:baseline,afterSectionIndex:indexedBefore,afterIdIndex:afterIndex,afterColumns:afterAll},
  checksum:{first,lookupSum,firstColumn:column.values[0],lastColumn:column.values.at(-1)}} ,null,2));
