import test from 'node:test';
import assert from 'node:assert/strict';
import { OutReader, MemorySource } from '../dist/index.js';
import { createPollutantOut } from './fixture-pollutants.mjs';

function sourceFor(data) {
  const stats = {calls:0, bytes:0, maxRead:0, inFlight:0, maxInFlight:0};
  const source = {size:data.length, async read(offset,length,options={}) {
    if (options.signal?.aborted) { const e = new Error('Aborted'); e.name='AbortError'; throw e; }
    assert.ok(offset>=0 && length>=0 && offset+length<=data.length);
    stats.calls++; stats.bytes+=length; stats.maxRead=Math.max(length,stats.maxRead);
    stats.inFlight++; stats.maxInFlight=Math.max(stats.inFlight,stats.maxInFlight);
    try {await Promise.resolve(); return data.slice(offset,offset+length);} finally {stats.inFlight--;}
  }};
  return {source,stats};
}
const requests = [
  {kind:'link',object:'D40',attribute:'flow'},
  {kind:'link',object:'L1',attribute:'velocity'},
  {kind:'node',object:'J1',attribute:'head'},
  {kind:'subcatch',object:'S1',attribute:'runoff'},
  {kind:'link',object:'D40',attribute:'flow'},
  {kind:'system',object:0,attribute:'rainfall'},
  {kind:'link',object:'D199',attribute:5},
];

test('mixed query matches legacy seriesMany in sparse, grouped and sequential modes', async () => {
  const bytes=createPollutantOut({periods:16,paddingLinks:200});
  const legacy=await OutReader.open(new MemorySource(bytes));
  const expected=await legacy.seriesMany(requests,2,13);
  for(const strategy of ['sparse','grouped','sequential','auto']) {
    const {source,stats}=sourceFor(bytes);
    const reader=await OutReader.open(source);
    const result=await reader.query({requests,periods:{from:2,to:13},strategy});
    assert.equal(result.layout,'series-major');
    assert.equal(result.seriesCount,requests.length);
    assert.equal(result.periodCount,11);
    assert.equal(result.values.length,11*requests.length);
    for(let i=0;i<requests.length;i++) assert.deepEqual(Array.from(result.column(i)),Array.from(expected[i]));
    assert.deepEqual(Array.from(result.column(0)),Array.from(result.column(4)), 'duplicate columns preserved');
    assert.ok(stats.calls > 0);
    assert.equal(stats.maxInFlight<=16,true);
    assert.equal(stats.maxRead <= 2*1024*1024,true);
  }
});

test('cartesian kind/objects/attributes order and memory-source fast path', async () => {
  const reader=await OutReader.open(new MemorySource(createPollutantOut({periods:5,paddingLinks:3})));
  const q={kind:'link',objects:['D2','L1'],attributes:['flow','depth'],periods:{from:1,to:4}};
  const plan=await reader.explainQuery(q);
  assert.equal(plan.strategy,'memory');
  assert.equal(plan.estimatedReadCalls,0);
  const result=await reader.query(q);
  assert.deepEqual(result.requests.map(x=>[x.object,x.attribute]),[['D2','flow'],['D2','depth'],['L1','flow'],['L1','depth']]);
  assert.deepEqual(Array.from(result.column(0)),Array.from(await reader.series('link','D2','flow',1,4)));
  assert.throws(()=>result.column(4),/column/);
  assert.throws(()=>result.column(-1),/column/);
});

test('streaming uses bounded chunks and matches query including final partial chunk', async () => {
  const reader=await OutReader.open(new MemorySource(createPollutantOut({periods:29,paddingLinks:200})));
  const spec={requests,periods:{from:3,to:28}};
  const full=await reader.query(spec);
  const chunks=[];
  for await(const chunk of reader.queryStream(spec,{chunkPeriods:7,maxOutputBytes:7*requests.length*4})) {
    assert.ok(chunk.values.byteLength<=7*requests.length*4);
    chunks.push(chunk);
  }
  assert.deepEqual(chunks.map(x=>[x.from,x.to]),[[3,10],[10,17],[17,24],[24,28]]);
  for(let col=0;col<requests.length;col++) {
    assert.deepEqual(chunks.flatMap(x=>Array.from(x.column(col))),Array.from(full.column(col)));
  }
});

test('stream bounds memory even when caller asks for very long chunk', async () => {
  const reader=await OutReader.open(new MemorySource(createPollutantOut({periods:13,paddingLinks:1})));
  const columns=[{kind:'link',object:'L1',attribute:'flow'},{kind:'link',object:'L1',attribute:'depth'}];
  const seen=[];
  for await(const part of reader.queryStream({requests:columns},{chunkPeriods:100000,maxOutputBytes:16})) seen.push(part.periodCount);
  assert.deepEqual(seen,[2,2,2,2,2,2,1]);
});

test('aggregateMany matches independent statistics, including repeated requests', async () => {
  const reader=await OutReader.open(new MemorySource(createPollutantOut({periods:57,paddingLinks:200})));
  const result=await reader.aggregateMany({requests,periods:{from:4,to:53}},{chunkPeriods:9});
  for(let col=0;col<requests.length;col++) {
    const r=requests[col];
    const stats=await reader.seriesStatistics(r.kind,r.object,r.attribute,4,53,17);
    assert.equal(result.finiteCount[col],stats.finiteCount);
    assert.equal(result.nonFiniteCount[col],stats.nonFiniteCount);
    assert.equal(result.min[col],stats.min);
    assert.equal(result.max[col],stats.max);
    assert.ok(Math.abs(result.mean[col]-stats.mean)<1e-10);
  }
});

test('validate limits, malformed selections and forced sequential I/O', async () => {
  const {source}=sourceFor(createPollutantOut({periods:3,paddingLinks:200}));
  const reader=await OutReader.open(source);
  await assert.rejects(reader.query({requests,periods:{from:0,to:3},maxMemoryBytes:4}),/budget/);
  await assert.rejects(reader.query({requests,periods:{from:4,to:5}}),/period range/);
  await assert.rejects(reader.query({requests,kind:'link',objects:[],attributes:[]}),/either/);
  await assert.rejects(reader.query({kind:'link',objects:['UNKNOWN'],attributes:['flow']}),/Unknown/);
  await assert.rejects(reader.query({requests,strategy:'sequential'}, {maxReadBytes:128}),/span/);
  await assert.rejects(async()=>{for await(const _part of reader.queryStream({requests},{maxOutputBytes:requests.length*4-1})) void _part;},/memory budget/);
});

test('an aborted query stops before reading results; streaming observes cancellation', async () => {
  const bytes=createPollutantOut({periods:24,paddingLinks:200});
  const {source}=sourceFor(bytes);
  const reader=await OutReader.open(source);
  const ctrl = new AbortController();ctrl.abort();
  await assert.rejects(reader.query({requests},{signal:ctrl.signal}),e=>e.name==='AbortError');
  const ctrl2=new AbortController();
  const generator=reader.queryStream({requests},{signal:ctrl2.signal,chunkPeriods:4});
  await generator.next(); ctrl2.abort();
  await assert.rejects(generator.next(),e=>e.name==='AbortError');
});

test('explainQuery is deterministic and accounts for selected bytes', async () => {
  const bytes=createPollutantOut({periods:123,paddingLinks:350});
  const {source}=sourceFor(bytes);
  const reader=await OutReader.open(source);
  const q={kind:'link',objects:['L1','D300','D349'],attributes:['flow','depth'],periods:{from:13,to:73}};
  const plans=await Promise.all(['sparse','grouped','sequential','auto'].map(strategy=>reader.explainQuery({...q,strategy})));
  assert.equal(plans[0].estimatedReadBytes,6*4*60);
  assert.ok(plans[1].estimatedReadBytes>=plans[0].estimatedReadBytes);
  assert.ok(plans[2].estimatedReadBytes>=plans[1].estimatedReadBytes);
  assert.equal(plans[3].outputBytes,6*4*60);
  assert.ok(plans[3].estimatedReadCalls>0);
});

test('auto planner caps over-reading for widely separated channels', async () => {
  const {source}=sourceFor(createPollutantOut({periods:21,paddingLinks:1100}));
  const reader=await OutReader.open(source);
  const q={kind:'link',objects:['L1','D1099'],attributes:['flow'],periods:{from:0,to:21}};
  const plan=await reader.explainQuery(q);
  assert.notEqual(plan.strategy,'sequential');
  const sparse=await reader.query(q);
  const seq=await reader.query({...q,strategy:'sequential'});
  assert.deepEqual(Array.from(sparse.values),Array.from(seq.values));
});
