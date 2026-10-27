import {test} from 'node:test';
import assert from 'node:assert/strict';
import {OutReader, OutIndexCache, AdaptiveOutIndex, MemorySource} from '../dist/index.js';
import {createOut} from './fixture.mjs';

const c1={kind:'link',object:'C1',attribute:'flow'};
const n1={kind:'node',object:'J1',attribute:'depth'};

async function model(periods=5000) {
  const source=new MemorySource(createOut(periods));
  const out=await OutReader.open(source);
  return {source,out};
}
function matchEnvelope(actual, expected) {
  assert.deepEqual([...actual.periods],[...expected.periods]);
  assert.deepEqual([...actual.values],[...expected.values]);
}

test('resident budget evicts least recently used channel; hits refresh recency',async()=>{
  const {out}=await model(513);
  const bytes=OutIndexCache.requiredBytes(513);
  const cache=new OutIndexCache({maxBytes:bytes*2});
  await cache.getOrBuild(out,c1,'sha256:fixed');
  await cache.getOrBuild(out,n1,'sha256:fixed');
  assert.equal(cache.stats().bytes,bytes*2);
  assert.ok(cache.get(out,c1,'sha256:fixed'));
  await cache.getOrBuild(out,{kind:'system',object:0,attribute:0},'sha256:fixed');
  assert.equal(cache.stats().entries,2);
  assert.equal(cache.stats().evictions,1);
  assert.equal(cache.get(out,n1,'sha256:fixed'),undefined);
  assert.ok(cache.get(out,c1,'sha256:fixed'));
  assert.ok(cache.evict(out,c1,'sha256:fixed'));
  assert.equal(cache.stats().entries,1);
  cache.clear();
  assert.equal(cache.stats().entries,0);
  assert.equal(cache.stats().bytes,0);
});

test('cache refuses too-large indexes before any series data reads',async()=>{
  const {out,source}=await model(5000);
  let reads=0;
  const spy={size:source.size, read:async (...args)=>{reads++;return source.read(...args)}};
  const spyOut=await OutReader.open(spy);
  reads=0;
  const cache=new OutIndexCache({maxBytes:1024});
  assert.equal(cache.canFit(5000),false);
  await assert.rejects(()=>cache.getOrBuild(spyOut,c1,'trusted'),RangeError);
  assert.equal(reads,0);
  assert.throws(()=>new OutIndexCache({maxBytes:-1}),RangeError);
  assert.throws(()=>new OutIndexCache({maxBytes:1000,maxEntries:-1}),RangeError);
});

test('simultaneous builds share one index and optional store persists across cache instances',async()=>{
  const {out}=await model(300);
  const map=new Map(); let loads=0,saves=0;
  const store={load:async k=>{loads++;return map.get(k)},save:async(k,b)=>{saves++;map.set(k,b)}};
  const cache=new OutIndexCache({maxBytes:100_000,store});
  const [a,b,c]=await Promise.all([
    cache.getOrBuild(out,c1,'sha256:same'),cache.getOrBuild(out,c1,'sha256:same'),cache.getOrBuild(out,c1,'sha256:same')
  ]);
  assert.equal(a,b);assert.equal(b,c);
  assert.equal(cache.stats().builds,1);assert.equal(saves,1);
  assert.equal(loads,1);assert.equal(cache.stats().inflight,0);
  const other=new OutIndexCache({maxBytes:100_000,store});
  const restored=await other.getOrBuild(out,c1,'sha256:same');
  assert.deepEqual(restored.extrema(),a.extrema());
  assert.equal(other.stats().restores,1);assert.equal(other.stats().builds,0);
  assert.ok(map.size===1);
});

test('invalid source key does not retrieve cached index or permit stale sidecar restoration',async()=>{
  const {out}=await model(180);
  const persisted=new Map();
  const store={load:async k=>persisted.get(k), save:async(k,v)=>persisted.set(k,v)};
  const cache=new OutIndexCache({maxBytes:100_000,store});
  await cache.getOrBuild(out,c1,'sha256:first');
  assert.equal(cache.get(out,c1,'sha256:second'),undefined);
  const different=await cache.getOrBuild(out,c1,'sha256:second');
  assert.notEqual(different.sourceKey,'sha256:first');
  const key=[...persisted.keys()].find(k=>k.includes('sha256:second'));
  persisted.set(key,new Uint8Array([0,1,2]));
  const reload=new OutIndexCache({maxBytes:100_000,store});
  await assert.rejects(()=>reload.getOrBuild(out,c1,'sha256:second'),/Invalid OUT index header/);
  assert.equal(reload.stats().entries,0);
});

test('adaptive policy keeps short series direct and promotes repeated larger charts',async()=>{
  const small=await model(120);
  const cache=new OutIndexCache({maxBytes:2*1024*1024});
  const adaptive=new AdaptiveOutIndex(cache,{promoteAfterQueries:2,minAverageDirectMs:0});
  for(let i=0;i<5;i++){
    const q=await adaptive.envelope(small.out,c1,'small',0,120,20);
    assert.equal(q.mode,'direct');
  }
  const big=await model(5000);
  const expected=await big.out.seriesEnvelope('link','C1','flow',50,4900,100);
  for(let i=0;i<2;i++){
    const q=await adaptive.envelope(big.out,c1,'big',50,4900,100);
    assert.equal(q.mode,'direct'); matchEnvelope(q.series,expected);
  }
  const promoted=await adaptive.envelope(big.out,c1,'big',50,4900,100);
  assert.equal(promoted.mode,'indexed');
  matchEnvelope(promoted.series,expected);
  assert.equal(cache.stats().entries,1);
  const next=await adaptive.envelope(big.out,c1,'big',50,4900,100);
  assert.equal(next.mode,'indexed');
  matchEnvelope(next.series,expected);
});

test('adaptive mode respects insufficient budgets and propagates abort',async()=>{
  const {out}=await model(5000);
  const adaptive=new AdaptiveOutIndex(new OutIndexCache({maxBytes:64}),{promoteAfterQueries:1,minAverageDirectMs:0});
  for(let i=0;i<3;i++)assert.equal((await adaptive.envelope(out,c1,'x',0,5000,200)).mode,'direct');
  const controller=new AbortController(); controller.abort();
  await assert.rejects(()=>adaptive.envelope(out,c1,'x',0,5000,200,{signal:controller.signal}),{name:'AbortError'});
});

test('clear during an in-flight build cannot reinsert the old index',async()=>{
  const {out}=await model(10000);
  let release; const promise=new Promise(r=>release=r);
  const store={load:()=>promise};
  const cache=new OutIndexCache({maxBytes:10*1024*1024,store});
  const work=cache.getOrBuild(out,c1,'immutable');
  cache.clear();
  release(undefined);
  const result=await work;
  assert.equal(result.periods,10000);
  assert.equal(cache.stats().entries,0);
});

test('a secondary caller can abort waiting without cancelling the shared build',async()=>{
  const {out}=await model(8000);
  let release;const gate=new Promise(r=>release=r);
  const store={load:()=>gate};
  const cache=new OutIndexCache({maxBytes:2*1024*1024,store});
  const primary=cache.getOrBuild(out,c1,'one');
  const controller=new AbortController();
  const secondary=cache.getOrBuild(out,c1,'one',{readOptions:{signal:controller.signal}});
  controller.abort();
  await assert.rejects(secondary,{name:'AbortError'});
  release(undefined);
  const built=await primary;
  assert.equal(built.periods,8000);
  assert.equal(cache.stats().entries,1);
});
