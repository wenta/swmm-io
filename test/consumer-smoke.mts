/** Consumer-side declaration check. Does not import implementation internals. */
import { BlobSource, InpModel, OutReader, type OutQuerySpec, type OutQueryChunk } from '../dist/index.js';

declare const modelFile: File;
declare const inputText: string;
const model = InpModel.parse(inputText);
const n: number | string | undefined = model.properties.get('CONDUITS', 'C1', 'length');
void n;

async function consumer(): Promise<OutQueryChunk | undefined> {
  const out = await OutReader.open(new BlobSource(modelFile));
  const objects = await out.ids('link');
  const columns = await out.columnNames('link');
  const attrs = columns.filter(c => ['flow', 'depth'].includes(c.name)).map(c => c.code);
  if (!objects.length || !attrs.length) return undefined;
  const query: OutQuerySpec = {
    kind: 'link', objects: objects.slice(0, 3), attributes: attrs,
    periods: { from: 0, to: Math.min(out.info.periods, 1000) }
  };
  await out.explainQuery(query);
  const result = await out.query(query, { maxOutputBytes: 32 << 20 });
  const first: Float32Array = result.column(0);
  void first;
  for await (const chunk of out.queryStream(query, { chunkPeriods: 50 })) {
    void chunk.values;
  }
  const stats = await out.aggregateMany(query);
  void stats.mean;
  return result;
}
void consumer;
