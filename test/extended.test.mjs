import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InpDocument, InpModel, RptDocument, OutReader, MemorySource, BlobSource } from '../dist/index.js';
import { createPollutantOut } from './fixture-pollutants.mjs';

const MODEL = `; EPA-inspired project\r\n[OPTIONS]\r\nFLOW_UNITS CMS\r\nROUTING_STEP 00:00:30\r\n[JUNCTIONS]\r\n J1 10 3 ; downstream pressure\r\n J2 8 5\r\n[CONDUITS]\r\n C1 J1 J2 100 0.013 0 0\r\n[COORDINATES]\r\nJ1 0 1\r\nJ2 2 3\r\n[SUBCATCHMENTS]\r\nS1 RG1 J1 1.2 30 40 0.1\r\n[UNSUPPORTED_EXTENSION]\r\nunknown here\r\n`;

test('INP typed model, topology and preserved unknown sections', () => {
  const model = InpModel.parse(MODEL);
  assert.equal(model.options().get('FLOW_UNITS'), 'CMS');
  assert.deepEqual([...model.nodes()].map(n => [n.id, n.x, n.y, n.invertElevation]), [['J1',0,1,10],['J2',2,3,8]]);
  assert.deepEqual([...model.links()].map(l => [l.id,l.length,l.roughness]), [['C1',100,0.013]]);
  assert.deepEqual([...model.subcatchments()].map(s => [s.id,s.area,s.imperviousPercent]), [['S1',1.2,30]]);
  const graph = model.topology();
  assert.equal(graph.nodes.size, 2);
  assert.deepEqual(graph.incoming.get('J2'), ['C1']);
  assert.deepEqual(graph.outgoing.get('J1'), ['C1']);
  assert.deepEqual(graph.dangling, []);
  assert.equal(model.document.toString(), MODEL);
});

test('INP update/append/remove are immutable and preserve other lines/comments/CRLF', () => {
  const original = InpDocument.parse(MODEL);
  const updated = original.replaceRow('junctions', 'J1', ['J1','11','3']);
  assert.match(updated.toString(), / J1 11 3 ; downstream pressure\r\n/);
  assert.equal(original.toString(), MODEL);
  const appended = updated.appendRow('JUNCTIONS', ['J3','7','5']);
  assert.deepEqual([...appended.ids('JUNCTIONS')], ['J1', 'J2', 'J3']);
  assert.match(appended.toString(), /J3 7 5\r\n\[CONDUITS\]/);
  const removed = appended.removeRow('JUNCTIONS','J3');
  assert.equal(removed.toString(), updated.toString());
  assert.throws(() => original.replaceRow('JUNCTIONS', 'MISSING', ['MISSING','1']), /exactly one/);
  assert.throws(() => original.appendRow('NOT_THERE', ['A','B']), /missing section/);
});

test('INP explicit dangling nodes, duplicate IDs, bad numbers and quoted semicolons', () => {
  const malformed = InpModel.parse('[JUNCTIONS]\nN1 eleven 4\n');
  assert.throws(() => [...malformed.nodes()], /invertElevation/);
  const dangles = InpModel.parse('[JUNCTIONS]\nN1 1 2\n[CONDUITS]\nC1 N1 MISSING 10 0.01\n');
  assert.deepEqual(dangles.topology().dangling, ['MISSING']);
  const q = InpDocument.parse('[TIMESERIES]\nT1 "some text" 1 ; comment\n');
  assert.deepEqual([...q.rows('TIMESERIES')][0].fields, ['T1','some text','1']);
  assert.throws(() => InpDocument.parse('[JUNCTIONS]\nJ1 2\nJ1 3\n').replaceRow('JUNCTIONS','J1',['J1','4']), /found 2/);
});

test('RPT parses standard EPA banners, warnings, errors, continuity', () => {
  const rpt = `EPA STORM WATER MANAGEMENT MODEL\r\n\r\n***************\r\nAnalysis Options\r\n***************\r\nFlow Units .................. CMS\r\n\r\n************************\r\nRunoff Quantity Continuity\r\n************************\r\nContinuity Error (%) .....  -0.386\r\n\r\n************************\r\nFlow Routing Continuity\r\n************************\r\nContinuity Error (%) .....  1.123\r\n WARNING 06: synthetic warning\r\n ERROR 03: test failure\r\n`;
  const report = RptDocument.parse(rpt);
  assert.equal(report.toString(), rpt);
  assert.deepEqual(report.sections.map(s => s.title), ['Analysis Options', 'Runoff Quantity Continuity','Flow Routing Continuity']);
  assert.deepEqual([...report.continuityErrors()], [['Runoff Quantity Continuity',-0.386],['Flow Routing Continuity',1.123]]);
  assert.equal(report.warnings.length, 1);
  assert.equal(report.errors.length, 1);
  assert.equal(report.sectionsNamed('analysis options').length, 1);
});

test('OUT pollutants: name, unit, values and batched series', async () => {
  const bytes = createPollutantOut();
  const out = await OutReader.open(new MemorySource(bytes));
  assert.deepEqual(await out.ids('pollutant'), ['TSS']);
  assert.deepEqual(await out.pollutantUnits(), [1]);
  assert.equal(out.info.nPollutants, 1);
  assert.deepEqual([...await out.pollutantSeries('subcatch', 'S1', 'TSS')], [10,11,12,13]);
  assert.deepEqual([...await out.pollutantSeries('node', 'J2', 0)], [30,31,32,33]);
  assert.deepEqual([...await out.pollutantSeries('link', 'L1', 'TSS')], [30,31,32,33]);
  assert.deepEqual((await out.seriesMany([
    {kind: 'link', object: 'L1', attribute:'flow'},
    {kind: 'node', object: 'J2', attribute:'depth'},
    {kind: 'link', object: 'L1', attribute:'flow'}
  ], 1,3)).map(x => [...x]), [[1,2],[101,102],[1,2]]);
  await assert.rejects(() => out.pollutantSeries('link', 'L1', 'BAD'), RangeError);
  await assert.rejects(() => out.series('system', 0, 'waterQuality'), RangeError);
});

test('OUT bulk and sparse batching agree on a large-stride binary stream', async () => {
  const sourceBytes = createPollutantOut({periods:40, paddingLinks:3500});
  let totalReads = 0;
  let bytesRead = 0;
  const counting = {
    size: sourceBytes.byteLength,
    async read(offset, n) { totalReads++; bytesRead += n; return sourceBytes.subarray(offset, offset+n); }
  };
  const reader = await OutReader.open(counting);
  const requests = [
    {kind:'link', object:'L1', attribute:'flow'},
    {kind:'link', object:'D3499', attribute:'velocity'},
    {kind:'node', object:'J1', attribute:'depth'}
  ];
  const bulk = await reader.seriesMany(requests, 0, 40, 'bulk');
  const bulkBytes = bytesRead;
  bytesRead = 0;
  const sparse = await reader.seriesMany(requests, 0, 40, 'sparse');
  assert.deepEqual(sparse.map(x=>[...x]), bulk.map(x=>[...x]));
  assert.ok(bulkBytes > bytesRead, `Expected less sparse I/O: bulk=${bulkBytes} sparse=${bytesRead}`);
  assert.ok(totalReads > 0);
  // Blob browser path returns the same result.
  const browser = await OutReader.open(new BlobSource(new Blob([sourceBytes])));
  const blob = await browser.seriesMany(requests, 0, 40, 'auto');
  assert.deepEqual(blob.map(x=>[...x]), bulk.map(x=>[...x]));
});

test('OUT rejects bad errors, truncation and corrupt pollutant metadata', async () => {
  await assert.rejects(() => OutReader.open(new MemorySource(createPollutantOut({errorCode: 12}))), /simulation failed/);
  const errored = await OutReader.open(new MemorySource(createPollutantOut({errorCode: 12})), {allowSimulationErrors: true});
  assert.equal(errored.info.errorCode, 12);
  const bytes = createPollutantOut();
  const footer = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  footer.setInt32(bytes.length - 24 + 8, 999999, true);
  await assert.rejects(() => OutReader.open(new MemorySource(bytes)), /section offsets/);
});

test('OUT constant-time scalar, complete result and vector timestamps', async () => {
  const bytes = createPollutantOut({periods:8});
  const memory = await OutReader.open(new MemorySource(bytes));
  const blob = await OutReader.open(new BlobSource(new Blob([bytes])));
  for (const out of [memory, blob]) {
    assert.equal(await out.value('node','J2','depth',3), 103);
    assert.equal(await out.value('link','L1','flow',7), 7);
    assert.deepEqual([...await out.objectResult('link','L1',2)], [2,3,4,5,6,32]);
    const serials = await out.timestampsSerial(2,6);
    assert.equal(serials.length, 4);
    for (let t=0;t<4;t++) assert.equal(serials[t],await out.timestampSerial(t+2));
    assert.deepEqual([...await out.timestampsSerial(0,0)], []);
    await assert.rejects(() => out.value('link','L1','flow',8), RangeError);
  }
});
