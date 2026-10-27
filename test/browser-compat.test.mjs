import test from 'node:test';
import assert from 'node:assert/strict';
import { BlobSource, MemorySource, OutReader } from '../dist/index.js';
import { createPollutantOut } from './fixture-pollutants.mjs';

test('browser BlobSource and MemorySource expose identical discovered columns and query data', async () => {
  const bytes = createPollutantOut({ periods: 19, paddingLinks: 5 });
  const fromFile = await OutReader.open(new BlobSource(new Blob([bytes])));
  const inMemory = await OutReader.open(new MemorySource(bytes));
  for (const kind of ['link', 'node', 'subcatch', 'pollutant']) {
    assert.deepEqual(await fromFile.ids(kind), await inMemory.ids(kind));
  }
  const available = await fromFile.columnNames('link');
  assert.ok(available.some(x => x.name === 'flow'), 'must discover flow');
  const ids = await fromFile.ids('link');
  const flow = available.find(x => x.name === 'flow');
  const spec = { kind: 'link', objects: ids.slice(0, 3), attributes: [flow.code], periods: { from: 0, to: 19 } };
  const blobResult = await fromFile.query(spec);
  const memoryResult = await inMemory.query(spec);
  assert.deepEqual([...blobResult.values], [...memoryResult.values]);
});
