import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OutReader, MemorySource, BlobSource } from '../dist/index.js';
import { createPollutantOut } from './fixture-pollutants.mjs';

function resultPos(bytes) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getInt32(bytes.length - 16, true);
}

// Independent expected values follow the explicit fixture constructor, not the reader.
test('OUT reads static properties including integer-coded link/node types', async () => {
  const out = await OutReader.open(new MemorySource(createPollutantOut({periods: 4})));
  const sub = await out.properties('subcatch');
  assert.deepEqual(sub.codes, [1]);
  assert.equal(sub.get(0, 1), 12.5);
  const nodes = await out.properties('node');
  assert.deepEqual(nodes.codes, [0,2,3]);
  assert.deepEqual([...nodes.values], [0,10,3,0,11,3]);
  assert.equal(nodes.get(1, 2), 11);
  const links = await out.properties('link');
  assert.deepEqual(links.codes, [0,4,4,3,5]);
  assert.equal(links.get(0,5), 50);
  assert.equal(links.get(0,0), 0);
  assert.throws(() => links.get(1,5), RangeError);
  assert.throws(() => links.get(0,100), RangeError);
  assert.equal(links.get(0,4,0), 1);
  assert.equal(links.get(0,4,1), 2);
  assert.strictEqual(await out.properties('link'), links);
});

test('OUT bounded streaming is equivalent to full-series read for Memory and Blob', async () => {
  const bytes = createPollutantOut({periods: 137});
  for (const source of [new MemorySource(bytes), new BlobSource(new Blob([bytes]))]) {
    const out = await OutReader.open(source);
    const chunks = [];
    const positions = [];
    for await (const c of out.seriesChunks('node','J2','depth', 4, 137, 11)) {
      assert.ok(c.end - c.start <= 11);
      positions.push([c.start, c.end]);
      chunks.push(...c.values);
    }
    assert.deepEqual(chunks, [...await out.series('node','J2','depth',4,137)]);
    assert.deepEqual(positions[0], [4,15]);
    assert.deepEqual(positions.at(-1), [136,137]);
    const nothing = [];
    for await (const chunk of out.seriesChunks('node','J2','depth',5,5)) nothing.push(chunk);
    assert.deepEqual(nothing, []);
    await assert.rejects(async () => {
      for await (const _ of out.seriesChunks('node','J2','depth',0,137,0)) {}
    }, /chunkPeriods/);
  }
});

test('OUT streaming statistics and envelope preserve min/max spikes and endpoints', async () => {
  const bytes = createPollutantOut({periods: 300});
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pos = resultPos(bytes);
  // One pollutant: 1 subcatch * 9 floats; 2 nodes * 7; link L1 flow at offset +100.
  const stride = 8 + 4*(9+14+6+15);
  view.setFloat32(pos + 41*stride + 100, 5000, true);
  view.setFloat32(pos + 142*stride + 100, -6000, true);
  view.setFloat32(pos + 200*stride + 100, NaN, true);
  for (const source of [new MemorySource(bytes), new BlobSource(new Blob([bytes]))]) {
    const out = await OutReader.open(source);
    const stats = await out.seriesStatistics('link','L1','flow',0,300,17);
    assert.equal(stats.totalPeriods, 300);
    assert.equal(stats.finiteCount, 299);
    assert.equal(stats.nonFiniteCount, 1);
    assert.equal(stats.min, -6000);
    assert.equal(stats.max, 5000);
    const full = await out.series('link','L1','flow');
    const expectedMean = [...full].filter(Number.isFinite).reduce((s,v)=>s+v,0)/299;
    assert.ok(Math.abs(stats.mean - expectedMean) < 1e-9);
    const sampled = await out.seriesEnvelope('link','L1','flow',0,300,34,13);
    assert.ok(sampled.values.length <= 34);
    assert.deepEqual([sampled.periods[0],sampled.periods.at(-1)], [0,299]);
    const peakIndex = [...sampled.periods].indexOf(41);
    const valleyIndex = [...sampled.periods].indexOf(142);
    assert.ok(peakIndex >= 0 && valleyIndex >= 0);
    assert.equal(sampled.values[peakIndex], 5000);
    assert.equal(sampled.values[valleyIndex], -6000);
    const periods = [...sampled.periods];
    assert.ok(periods.every((p,i)=>i===0 || p>periods[i-1]), 'Periods in ascending order');
    const short = await out.seriesEnvelope('link', 'L1', 'flow', 40,44, 4);
    assert.deepEqual([...short.values], [40,5000,42,43]);
    const empty = await out.seriesEnvelope('link','L1','flow',22,22,10);
    assert.equal(empty.values.length,0);
    await assert.rejects(() => out.seriesEnvelope('link','L1','flow',0,10,3), /maxPoints/);
  }
});

test('OUT handles zero reported network objects and all-nonfinite result', async () => {
  const bytes = createPollutantOut({periods: 9});
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const base = resultPos(bytes);
  const stride = 8+4*(9+14+6+15);
  for (let p=0;p<9;p++) v.setFloat32(base + p*stride + 100, Infinity, true);
  const out = await OutReader.open(new MemorySource(bytes));
  const stats = await out.seriesStatistics('link','L1','flow',0,9,2);
  assert.equal(stats.finiteCount,0);
  assert.equal(stats.nonFiniteCount,9);
  assert.ok(Number.isNaN(stats.mean));
  const sample = await out.seriesEnvelope('link','L1','flow',0,9,4,2);
  assert.deepEqual([...sample.periods], [0,8]);
  assert.equal(sample.values[0], Infinity);
  assert.equal(sample.values[1], Infinity);
});

test('INP supports UTF-8 BOM without losing the exact original text', async () => {
  const { InpDocument } = await import('../dist/index.js');
  const text = '\uFEFF[OPTIONS]\r\nFLOW_UNITS CMS\r\n';
  const inp = InpDocument.parse(text);
  assert.deepEqual([...inp.rows('OPTIONS')].map(x=>x.fields), [['FLOW_UNITS','CMS']]);
  assert.equal(inp.toString(), text);
});
