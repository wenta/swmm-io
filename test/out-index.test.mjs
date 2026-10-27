import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutReader, OutSeriesIndex, MemorySource, BlobSource } from '../dist/index.js';
import { createOut } from './fixture.mjs';

const req = { kind:'link', object:'C1', attribute:'flow' };
async function checkEnvelope(n, start, end, maxPoints) {
  const bytes = createOut(n);
  const out = await OutReader.open(new MemorySource(bytes));
  const index = await OutSeriesIndex.build(out, req, {sourceKey:'sha256:fixture'});
  const expected = await out.seriesEnvelope('link', 'C1', 'flow', start, end, maxPoints);
  const actual = index.envelope(start, end, maxPoints);
  assert.deepEqual([...actual.periods], [...expected.periods]);
  assert.deepEqual([...actual.values], [...expected.values]);
}

test('indexed envelope is exactly equivalent to streaming raw envelope across uneven buckets', async () => {
  for (const n of [1,2,3,4,17,63,64,65,141,255,256,301,505,1023]) {
    for (const max of [4,5,6,8,13,33,1000]) {
      await checkEnvelope(n,0,n,max);
      if (n>20) await checkEnvelope(n,2,n-3,max);
    }
  }
});

test('ties, NaN, infinities and negative values keep original buckets and endpoints', async () => {
  const bytes = createOut(257);
  const view = new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const end=bytes.length-24;
  const results=view.getInt32(end+8,true);
  const stride=(end-results)/257;
  const set=(p,v)=>view.setFloat32(results+p*stride+88,v,true);
  set(0,NaN); set(1,Infinity); set(2,-Infinity); set(14,-123);
  set(15,900); set(16,900); set(17,-123); set(40,-2000); set(96,6500); set(256,NaN);
  const out = await OutReader.open(new MemorySource(bytes));
  const index = await OutSeriesIndex.build(out,req,{sourceKey:'sha256:modified'});
  assert.deepEqual(index.extrema(14,18),{min:-123,minPeriod:14,max:900,maxPeriod:15});
  assert.equal(index.extrema(0,3),null);
  assert.ok(Number.isNaN(index.value(0)));
  assert.ok(Number.isNaN(index.value(256)));
  assert.equal(index.value(1),Infinity);
  for (const [from,to] of [[0,257],[1,98],[50,250],[235,257],[0,2]]) {
    for (const max of [4,5,20,37,257]) {
      const expected=await out.seriesEnvelope('link','C1','flow',from,to,max);
      const actual=index.envelope(from,to,max);
      assert.deepEqual([...actual.periods],[...expected.periods]);
      assert.deepEqual([...actual.values],[...expected.values]);
    }
  }
});

test('persistent sidecar round-trips and refuses stale source keys, damaged layout and corrupted pointers',async()=>{
  const out=await OutReader.open(new MemorySource(createOut(300)));
  const index=await OutSeriesIndex.build(out,req,{sourceKey:'sha256:immutable-fixture'});
  const data=index.serialize();
  const restored=OutSeriesIndex.restore(out,data,{sourceKey:'sha256:immutable-fixture'});
  // fs.readFile returns Node Buffer. A sliced Buffer may have a non-zero
  // byteOffset in its underlying pooled ArrayBuffer; restore MUST NOT assume 0.
  const pooled=Buffer.allocUnsafe(data.length+37);
  pooled.set(data,23);
  const fromBuffer=OutSeriesIndex.restore(out,pooled.subarray(23,23+data.length),{sourceKey:'sha256:immutable-fixture'});
  assert.deepEqual(fromBuffer.extrema(12,200),index.extrema(12,200));
  assert.deepEqual(restored.extrema(7,133),index.extrema(7,133));
  assert.deepEqual([...restored.envelope(13,247,23).values],[...index.envelope(13,247,23).values]);
  assert.deepEqual(restored.request,req);
  assert.equal(restored.indexBytes, index.indexBytes);
  assert.throws(()=>OutSeriesIndex.restore(out,data,{sourceKey:'different'}),/incompatible/);
  assert.throws(()=>OutSeriesIndex.restore(out,data.subarray(0,31),{sourceKey:'sha256:immutable-fixture'}));
  assert.throws(()=>OutSeriesIndex.restore(out,data,{sourceKey:'sha256:immutable-fixture',maxIndexBytes:16}),RangeError);
  await assert.rejects(()=>OutSeriesIndex.build(out,req,{sourceKey:'x',maxIndexBytes:16}),RangeError);
  const truncated = data.subarray(0,data.length-2);
  assert.throws(()=>OutSeriesIndex.restore(out,truncated,{sourceKey:'sha256:immutable-fixture'}),/checksum|Truncated/);
  const corrupted=data.slice();corrupted[Math.floor(corrupted.length/2)]^=1;
  assert.throws(()=>OutSeriesIndex.restore(out,corrupted,{sourceKey:'sha256:immutable-fixture'}),/checksum/);
  assert.throws(()=>OutSeriesIndex.restore(out,data,{sourceKey:'sha256:immutable-fixture',expectedRequest:{kind:'node',object:'J1',attribute:'depth'}}),/request mismatch/);
  const broken=data.slice();broken[0]=0;
  assert.throws(()=>OutSeriesIndex.restore(out,broken,{sourceKey:'sha256:immutable-fixture'}),/magic/);
  const other=await OutReader.open(new MemorySource(createOut(299)));
  assert.throws(()=>OutSeriesIndex.restore(other,data,{sourceKey:'sha256:immutable-fixture'}),/incompatible/);
});

test('indexed requests make zero source reads and index build respects AbortSignal', async()=>{
  const memory=new MemorySource(createOut(113));let reads=0;
  const spy={size:memory.size,read:async(a,b,options)=>{reads++;return memory.read(a,b,options)}};
  const out=await OutReader.open(spy);
  const index=await OutSeriesIndex.build(out,req,{sourceKey:'source'});
  reads=0;
  for(let i=0;i<50;i++) index.envelope(0,113,15);
  assert.equal(reads,0);
  assert.deepEqual(index.extrema(0,113),{min:100,minPeriod:0,max:1220,maxPeriod:112});
  const abort=new AbortController();abort.abort();
  await assert.rejects(()=>OutSeriesIndex.build(out,req,{sourceKey:'source',readOptions:{signal:abort.signal}}),{name:'AbortError'});
  assert.throws(()=>index.envelope(0,113,30,abort.signal),{name:'AbortError'});
});

test('building index through BlobSource stays bounded and provides exact results',async()=>{
  const bytes=createOut(5000);
  const out=await OutReader.open(new BlobSource(new Blob([bytes])));
  const index=await OutSeriesIndex.build(out,req,{sourceKey:'sha256:blob',chunkPeriods:129,readOptions:{maxReadBytes:64*1024}});
  assert.equal(index.periods,5000);
  assert.deepEqual([...index.envelope(200,4990,70).values],
    [...(await out.seriesEnvelope('link','C1','flow',200,4990,70,1000,{maxReadBytes:64*1024})).values]);
});
