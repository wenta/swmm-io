import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InpDocument, OutReader, MemorySource, BlobSource, FileHandleSource } from '../dist/index.js';
import { createOut } from './fixture.mjs';
import { open, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const inp = '; header\r\n[TITLE]\r\nTest model\r\n[JUNCTIONS]   ; junctions\r\n; comment\r\n J1   100   5 ; inlet\r\n J2  99  5\r\n[CONDUITS]\r\nC1 J1 J2 200 0.01\r\n[JUNCTIONS]\r\n J3 98 5\r\n';
test('INP indexes sections, iterates lazily, keeps exact source', () => {
  const doc = InpDocument.parse(inp);
  assert.deepEqual(doc.sections, ['TITLE', 'JUNCTIONS', 'CONDUITS']);
  assert.equal(doc.toString(), inp);
  assert.deepEqual([...doc.ids('junctions')], ['J1', 'J2', 'J3']);
  assert.equal([...doc.rows('JUNCTIONS')][0].comment, ' inlet');
  assert.deepEqual([...doc.rows('CONDUITS')][0].fields, ['C1', 'J1', 'J2', '200', '0.01']);
});

test('OUT parses metadata, object IDs, time series and snapshot', async () => {
  const out = await OutReader.open(new MemorySource(createOut()));
  assert.equal(out.info.periods, 3);
  assert.equal(out.info.version, 52004);
  assert.equal(out.info.reportStepSeconds, 300);
  assert.equal(out.info.bytesPerPeriod, 8+(8+2*6+5+15)*4);
  assert.deepEqual(await out.ids('node'), ['J1','J2']);
  assert.deepEqual(await out.ids('link'), ['C1']);
  assert.deepEqual([...await out.series('link','C1','flow')], [100,110,120]);
  assert.deepEqual([...await out.series('node','J2','depth',1,3)], [11,12]);
  assert.deepEqual([...await out.snapshot('node','depth',1)], [1,11]);
  assert.deepEqual([...await out.series('system',0,'rainfall')], [501,511,521]);
  assert.equal((await out.timestamp(0)).toISOString(), '2009-07-06T00:05:00.000Z');
  await assert.rejects(() => out.series('link','UNKNOWN','flow'), RangeError);
  await assert.rejects(() => out.series('node',2,'depth'), RangeError);
  await assert.rejects(() => out.series('link','C1','flow',3,5), RangeError);
});

test('OUT supports lazy Blob slices and filesystem random access', async () => {
  const bytes = createOut(9);
  const blob = await OutReader.open(new BlobSource(new Blob([bytes])));
  assert.deepEqual([...await blob.series('link','C1','flow',2,5)], [120,130,140]);
  assert.deepEqual([...await blob.series('link','C1','flow',0,9,'sparse')], Array.from({length:9}, (_,p) => 100+p*10));
  const path = join(tmpdir(), `swmm-io-test-${process.pid}.out`);
  await writeFile(path, bytes);
  try {
    const handle = await open(path, 'r');
    const file = await OutReader.open(new FileHandleSource((await stat(path)).size, handle));
    assert.deepEqual([...await file.series('link', 0, 0)], Array.from({length:9}, (_,p) => 100+p*10));
    await file.close();
  } finally { await rm(path, { force: true }); }
});

test('OUT rejects malformed/truncated data and bad code', async () => {
  const bytes = createOut();
  await assert.rejects(() => OutReader.open(new MemorySource(bytes.slice(0,10))), /too small/);
  const invalid = bytes.slice();
  invalid[0] = 0;
  await assert.rejects(() => OutReader.open(new MemorySource(invalid)), /magic/);
  const invalidEnd = bytes.slice();
  new DataView(invalidEnd.buffer).setInt32(invalidEnd.length-24+12, 9999, true);
  await assert.rejects(() => OutReader.open(new MemorySource(invalidEnd)), /Truncated/);
});
