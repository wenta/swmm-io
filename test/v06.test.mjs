import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InpModel, InpDocument, validateInp, OutReader, MemorySource, BlobSource, FileHandleSource } from '../dist/index.js';
import { createOut } from './fixture.mjs';

const INP = `[RAINGAGES]\nRG INTENSITY 0:05 1.0 TIMESERIES T\n[JUNCTIONS]\nA 0 2\nB 0 2\nC 0 2\n[CONDUITS]\nC1 A B 30 0.013 0 *\nC2 B C 40 0.014 0 2\nC3 B C 50 0.015\n[SUBCATCHMENTS]\nS1 RG A 2.5 30 40 0.1\n[XSECTIONS]\nC1 CIRCULAR 1 0 0 0 1\nC2 CIRCULAR 1 0 0 0 1\nC3 CIRCULAR 1 0 0 0 1\n`;

test('batch properties preserve ID order, missing values, * and cache semantics', () => {
  const model = InpModel.parse(INP);
  const ids = ['C3','NOT-FOUND','C1','C2','C1'];
  const fields = ['length', 'roughness', 'outletOffset'];
  const p = model.properties;
  const expected = ids.map(id => fields.map(field => p.get('CONDUITS', id, field)));
  assert.deepEqual(p.getMany('CONDUITS', ids, fields).rows, expected);
  const numeric = p.numericMany('CONDUITS', ids, fields);
  assert.deepEqual([...numeric.columns[0]], [50, NaN, 30, 40, 30]);
  assert.deepEqual([...numeric.columns[2]], [NaN, NaN, NaN, 2, NaN]);
  p.materialize('CONDUITS', ['length','roughness','outletOffset']);
  assert.deepEqual(p.getMany('CONDUITS', ids, fields).rows, expected);
  assert.deepEqual([...p.numericMany('CONDUITS', ids, fields).columns[0]], [50,NaN,30,40,30]);
  assert.equal(p.getMany('CONDUITS',['C1'],['outletOffset']).rows[0][0], '*');
  assert.throws(() => p.getMany('CONDUITS',['C1'],['unknown']), /Unknown/);
  assert.throws(() => p.numericMany('CONDUITS',['C1'],['fromNode']), /not numeric/);
  assert.throws(() => p.numericMany('XSECTIONS',['C1'],['geometry1']), /fixed-layout/);
  const malformed=InpModel.parse('[CONDUITS]\nC1 A B invalid 0.01');
  assert.throws(()=>malformed.properties.numericMany('CONDUITS',['C1'],['length']), SyntaxError);
});

test('validator separates parsing from diagnostics and remains bounded', () => {
  const valid = InpModel.parse(INP);
  assert.deepEqual(valid.validate({level:'full'}), []);
  assert.equal(valid.document.toString(), INP);
  const broken = `[JUNCTIONS]\nA 0 -1\nA nope 2\n[CONDUITS]\nC1 A MISSING -1 0\nC1 A MISSING 5 0.01\n[SUBCATCHMENTS]\nS RG1 XYZ 1 120 40\n`;
  const model=InpModel.parse(broken);
  assert.equal(model.document.toString(),broken);
  const errors=model.validate({level:'full'});
  const codes=errors.map(x=>x.code);
  assert.ok(codes.includes('DUPLICATE_ID'));
  assert.ok(codes.includes('UNKNOWN_NODE'));
  assert.ok(codes.includes('UNKNOWN_RAINGAGE'));
  assert.ok(codes.includes('UNKNOWN_OUTLET'));
  assert.ok(codes.includes('OUT_OF_RANGE'));
  assert.ok(codes.includes('INVALID_NUMBER'));
  assert.ok(codes.includes('MISSING_XSECTION'));
  assert.equal(errors.find(x=>x.code==='UNKNOWN_NODE').section,'CONDUITS');
  assert.equal(validateInp(InpDocument.parse(broken),{maxIssues:3,level:'full'}).length,3);
  assert.throws(()=>model.validate({maxIssues:0}),RangeError);
  assert.deepEqual(model.validate({level:'basic'}).filter(x=>x.code==='INVALID_NUMBER'), []);
});

test('selective output snapshot matches full snapshot, object results and deduplicates requests', async () => {
  const bytes=createOut(15);
  for (const source of [new MemorySource(bytes), new BlobSource(new Blob([bytes]))]) {
    const out=await OutReader.open(source);
    const ids=['J2','J1','J2'];
    const selected=await out.snapshotSelected('node','depth',5,ids);
    const snapshot=await out.snapshot('node','depth',5);
    assert.deepEqual([...selected.values],[snapshot[1],snapshot[0],snapshot[1]]);
    const single = await out.snapshotSelected('link','flow',3,['C1']);
    assert.deepEqual([...single.values], [await out.value('link','C1','flow',3)]);
    assert.equal((await out.snapshotSelected('link','flow',3,[])).values.length,0);
    const two = await out.seriesMany([
      {kind:'node',object:'J1',attribute:'depth'},
      {kind:'link',object:'C1',attribute:'flow'}],2,5,'sparse',{maxReadBytes:64,maxConcurrency:2});
    assert.deepEqual([...two[0]],[2,3,4]);
    await assert.rejects(()=>out.snapshotSelected('node','depth',5,ids,{maxOutputBytes:8}),RangeError);
    await assert.rejects(()=>out.series('node','J1','depth',0,15,'sparse',{maxOutputBytes:10}),RangeError);
    await assert.rejects(()=>out.series('node','J1','depth',0,15,'sparse',{maxConcurrency:0}),RangeError);
    const controller=new AbortController();controller.abort();
    await assert.rejects(()=>out.snapshotSelected('node','depth',5,ids,{signal:controller.signal}),{name:'AbortError'});
    await assert.rejects(()=>out.series('node','J1','depth',0,15,'sparse',{signal:controller.signal}),{name:'AbortError'});
  }
});

test('sparse read avoids whole large period and bounds all source reads', async () => {
  const source=new MemorySource(createOut(200));
  const reads=[];
  const wrapped={size:source.size,async read(at,n){reads.push(n);return source.read(at,n)}};
  const out=await OutReader.open(wrapped);
  reads.length=0;
  const values=await out.seriesMany([{kind:'node',object:'J1',attribute:'depth'}, {kind:'link',object:'C1',attribute:'flow'}],0,100,'sparse',{maxReadBytes:32,maxConcurrency:3});
  assert.equal(values[0].length,100);
  assert.ok(reads.every(size=>size<=32));
  assert.ok(reads.length>0);
  await assert.rejects(()=>out.seriesMany([{kind:'node',object:'J1',attribute:'depth'},{kind:'link',object:'C1',attribute:'flow'}],0,100,'bulk',{maxReadBytes:16}),/Bulk span/);
});

// A 3 GiB virtual output with EPA-compatible signed 32-bit section offsets but
// results spanning beyond 2 GiB. Test never allocates multi-GB buffers.
test('virtual >2 GB output supports safe >2 GB result positions', async () => {
  const sample=createOut(2);
  const view=new DataView(sample.buffer,sample.byteOffset,sample.byteLength);
  const footer=sample.length-24;
  const results=view.getInt32(footer+8,true);
  const stride=(footer-results)/2;
  const periods=Math.ceil((2**31 + 4096-results)/stride);
  const size=results+stride*periods+24;
  assert.ok(size>2**31);
  const last=new Uint8Array(24);
  last.set(sample.subarray(footer,footer+24));
  new DataView(last.buffer).setInt32(12,periods,true);
  const source={size,async read(at,n){
    const out=new Uint8Array(n);
    if(at>=size-24) {out.set(last.subarray(at-(size-24),at-(size-24)+n));return out;}
    for(let i=0;i<n;i++){
      const pos=at+i;
      if(pos<results)out[i]=sample[pos];
      else {const within=(pos-results)%stride;out[i]=sample[results+within];}
    }
    return out;
  }};
  const out=await OutReader.open(source);
  const nearEnd=periods-2;
  const series=await out.series('link','C1','flow',nearEnd,periods,'sparse',{maxReadBytes:32});
  assert.deepEqual([...series],[100,100]);
  const selected=await out.snapshotSelected('link','flow',periods-1,['C1'],{maxReadBytes:32});
  assert.equal(selected.values[0],100);
});

test('parallel ID and property lookups single-flight one metadata read', async () => {
  const memory=new MemorySource(createOut(30));
  let idSectionReads=0;
  let readCount=0;
  const trace={ size:memory.size, async read(offset,length) {
    readCount++;
    if (offset === 28) idSectionReads++;
    return memory.read(offset,length);
  }};
  const out=await OutReader.open(trace);
  const start=readCount;
  const selected=await out.snapshotSelected('node','depth',3,Array.from({length:1000},(_,i)=>i%2?'J2':'J1'));
  assert.equal(selected.values.length,1000);
  assert.equal(idSectionReads,1, 'IDs must be decoded once even with 1000 concurrent calls');
  assert.ok(readCount-start<200, `Unexpected I/O amplification ${readCount-start}`);
  const staticValues=await Promise.all(Array.from({length:50},()=>out.propertyValue('node','J1','maxDepth')));
  assert.ok(staticValues.every(v=>Object.is(v,staticValues[0])));
});

test('streaming output supports cooperative cancellation and resource limits', async () => {
  const out=await OutReader.open(new BlobSource(new Blob([createOut(200)])));
  const controller=new AbortController();
  const iterator=out.seriesChunks('node','J1','depth',0,200,25,'auto',{signal:controller.signal});
  const first=await iterator.next();assert.equal(first.value.values.length,25);
  controller.abort();
  await assert.rejects(()=>iterator.next(),{name:'AbortError'});
  await assert.rejects(()=>out.snapshot('node','depth',0,{maxOutputBytes:4}),RangeError);
  await assert.rejects(()=>out.seriesStatistics('node','J1','depth',0,20,10,{signal:controller.signal}),{name:'AbortError'});
});
