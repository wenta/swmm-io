import { performance } from 'node:perf_hooks';
import { InpDocument, OutReader, MemorySource, BlobSource } from '../dist/index.js';
import { createOut } from './fixture.mjs';

const models = 50_000;
const text = '[JUNCTIONS]\n' + Array.from({length:models}, (_,i)=>`J${i} 100 5\n`).join('') +
  '[CONDUITS]\n' + Array.from({length:models-1}, (_,i)=>`C${i} J${i} J${i+1} 100 0.01\n`).join('');
let t = performance.now();
const inp = InpDocument.parse(text);
const indexMs = performance.now()-t;
t = performance.now();
const rows = [...inp.rows('CONDUITS')];
const rowsMs = performance.now()-t;
const bytes = createOut(50_000); // approx 10 MB synthetic fixture, not EPA engine generated
t = performance.now();
const out = await OutReader.open(new MemorySource(bytes));
const metaMs = performance.now()-t;
t = performance.now();
const values = await out.series('link','C1','flow');
const memMs = performance.now()-t;
t = performance.now();
const file = await OutReader.open(new BlobSource(new Blob([bytes])));
const blobValues = await file.series('link',0,'flow');
const blobMs = performance.now()-t;
if (rows.length !== models-1 || values.length !== 50_000 || blobValues.length !== 50_000) throw Error('Bad benchmark run');
console.log(JSON.stringify({
  node: process.version,
  inpKiB: Math.round(text.length /1024), inpRows: models*2-1,
  inpIndexMs: +indexMs.toFixed(2), inpMaterializeConduitsMs: +rowsMs.toFixed(2),
  outMiB: +(bytes.byteLength/1048576).toFixed(2), outPeriods: 50000,
  outMetadataMs: +metaMs.toFixed(2), outInMemoryLinkSeriesMs: +memMs.toFixed(2),
  outBlobLinkSeriesMs: +blobMs.toFixed(2)
},null,2));
