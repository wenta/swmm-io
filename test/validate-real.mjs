#!/usr/bin/env node
/**
 * Validation harness for an installed/build `swmm-io` v0.3.x.
 * Downloads ORIGINAL datasets from their owners: no model files are redistributed.
 * Usage (from extracted swmm-io source folder):
 *   npm run build
 *   node ./test/validate-real.mjs --download
 *   node ./test/validate-real.mjs --download --large
 *   node ./test/validate-real.mjs --download --stress
 * The harness imports ../dist/index.js relative to itself.
 */
import assert from 'node:assert/strict';
import { open, readFile, mkdir, stat } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { resolve, dirname, basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { InpDocument, InpModel, OutReader, FileHandleSource } from '../dist/index.js';

const args = new Set(process.argv.slice(2));
const shouldDownload = args.has('--download');
const selection = args.has('--stress') ? 'stress' : args.has('--large') ? 'large' : 'standard';
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = process.env.SWMM_REAL_FIXTURES_DIR || join(repo, 'real-fixtures');
const url = (owner, branch, prefix, file) =>
  `https://raw.githubusercontent.com/${owner}/${branch}/${prefix}/${encodeURIComponent(file)}`;

const cases = [
  { name: 'Norfolk Brambleton', group: 'standard', inp: url('UVAdMIST/smart_stormwater_swmm_models', 'master', 'brambleton', 'brambleton.inp'), inpSize: 182503, expected: { nodes: 375, links: 374, subcatch: 196 } },
  { name: 'Norfolk Hague', group: 'standard', inp: url('UVAdMIST/smart_stormwater_swmm_models', 'master', 'hague_model', 'hague_v10.inp'), inpSize: 204624, expected: { nodes: 209, links: 210, subcatch: 165 } },
  { name: 'EPA Froude dampening', group: 'standard', inp: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', 'froude_dampen.inp'), inpSize: 966071, expected: { nodes: 1868, links: 1891, subcatch: 0 } },
  { name: 'EPA 72 H&H', group: 'standard', inp: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', '72_H&H_Elements.inp'), out: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', '72_H&H_Elements.out'), inpSize: 86633, outSize: 440275, expected: { nodes: 37, links: 36, subcatch: 42, periods: 145 } },
  { name: 'EPA 5 H&H', group: 'standard', inp: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', '5_H&H_Elements.inp'), out: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', '5_H&H_Elements.out'), inpSize: 35923, outSize: 462487, expected: { nodes: 28, links: 27, subcatch: 10, periods: 288 } },
  { name: 'EPA AkanYen', group: 'standard', inp: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', 'AkanYen.inp'), out: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', 'AkanYen.out'), inpSize: 6519, outSize: 171413, expected: { nodes: 7, links: 6, subcatch: 0, periods: 480 } },
  { name: 'EPA 3 Pumps', group: 'standard', inp: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', '3_Pumps_KW_Ideal_Pumps.inp'), out: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', '3_Pumps_KW_Ideal_Pumps.out'), inpSize: 2945, outSize: 8821, expected: { nodes: 2, links: 3, subcatch: 0, periods: 48 } },
  { name: 'EPA airBreak', group: 'standard', inp: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', 'airBreak_model.inp'), out: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', 'airBreak_model.out'), inpSize: 7175, outSize: 552605, expected: { nodes: 8, links: 7, subcatch: 0, periods: 1380 } },
  { name: 'EPA 429 H&H', group: 'large', inp: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', '429_H&H_Elements.inp'), out: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', '429_H&H_Elements.out'), inpSize: 138910, outSize: 2908675, expected: { nodes: 209, links: 204, subcatch: 28 } },
  { name: 'EPA 17100 H&H', group: 'large', inp: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', '17100_H&H_Dummy_Link_Elements.inp'), out: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'EPA', '17100_H&H_Dummy_Link_Elements.out'), inpSize: 4023184, outSize: 53759218 },
  { name: 'NCIMM 275000 H&H', group: 'stress', inp: url('SWMMEnablement/1729-SWMM5-Models', 'main', 'SWMM5_NCIMM', '275000_H&H_Elements.inp'), inpSize: 66203137 }
];

function pathFor(urlString) {
  const path = new URL(urlString).pathname;
  const filename = decodeURIComponent(path.split('/').pop());
  const root = path.includes('/hague_model/') ? 'hague' : path.includes('/brambleton/') ? 'brambleton' : path.includes('/SWMM5_NCIMM/') ? 'ncimm' : 'epa';
  return join(dataDir, root, filename);
}

async function ensure(urlString, expectedSize) {
  const file = pathFor(urlString);
  await mkdir(dirname(file), { recursive: true });
  try {
    const existing = await stat(file);
    if (existing.size === expectedSize) return file;
    if (!shouldDownload) throw Error(`Wrong fixture size for ${file}; expected ${expectedSize}, got ${existing.size}`);
  } catch (error) {
    if (!shouldDownload) throw new Error(`Missing local fixture ${file}; use --download (${error.message})`);
  }
  const response = await fetch(urlString, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} for ${urlString}`);
  const tmp = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tmp));
    assert.equal((await stat(tmp)).size, expectedSize, `Unexpected downloaded file size: ${urlString}`);
    const { rename } = await import('node:fs/promises');
    await rename(tmp, file);
  } catch (e) {
    const { rm } = await import('node:fs/promises');
    await rm(tmp, { force: true });
    throw e;
  }
  return file;
}

function equalScalar(a, b) {
  return Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b));
}

async function run(testCase) {
  const start = performance.now();
  const inpPath = await ensure(testCase.inp, testCase.inpSize);
  const inpText = await readFile(inpPath, 'utf8');
  const doc = InpDocument.parse(inpText);
  assert.equal(doc.toString(), inpText, 'Lossless INP parse failed');
  const model = new InpModel(doc);
  const net = model.topology();
  const subcatch = [...model.subcatchments()].length;
  assert.equal(net.dangling.length, 0, `Dangling endpoints: ${net.dangling.slice(0, 8)}`);
  if (testCase.expected) {
    for (const [key, value] of Object.entries(testCase.expected)) {
      if (key === 'nodes') assert.equal(net.nodes.size, value, 'Wrong node count');
      if (key === 'links') assert.equal(net.links.size, value, 'Wrong link count');
      if (key === 'subcatch') assert.equal(subcatch, value, 'Wrong subcatchment count');
    }
  }
  const parseMs = performance.now() - start;
  const result = { name: testCase.name, inpBytes: testCase.inpSize, sections: doc.sections.length, nodes: net.nodes.size, links: net.links.size, subcatch, inpMs: Math.round(parseMs * 100) / 100 };
  if (!testCase.out) return result;
  const outPath = await ensure(testCase.out, testCase.outSize);
  const handle = await open(outPath, 'r');
  try {
    const reader = await OutReader.open(new FileHandleSource((await stat(outPath)).size, handle));
    assert.equal(reader.info.nSubcatch, subcatch, 'INP/OUT subcatch mismatch');
    assert.equal(reader.info.nNodes, net.nodes.size, 'INP/OUT nodes mismatch');
    assert.equal(reader.info.nLinks, net.links.size, 'INP/OUT links mismatch');
    if (testCase.expected?.periods !== undefined) assert.equal(reader.info.periods, testCase.expected.periods);
    for (const kind of ['subcatch', 'node', 'link', 'pollutant']) await reader.ids(kind);
    const periods = reader.info.periods;
    assert.ok(periods > 0, 'Output contains no periods');
    const ts0 = await reader.timestampSerial(0);
    const tsN = await reader.timestampSerial(periods - 1);
    assert.ok(tsN >= ts0, 'Non-monotonic first/last timestamps');
    const probes = [];
    for (const [kind, variable, count] of [ ['node', 'depth', net.nodes.size], ['link', 'flow', net.links.size], ['subcatch', 'runoff', subcatch] ]) {
      if (count === 0) continue;
      const ids = await reader.ids(kind);
      const id = ids[0];
      const n = Math.min(256, periods);
      const series = await reader.series(kind, id, variable, 0, n);
      assert.equal(series.length, n);
      const p = Math.floor(n / 2);
      assert.ok(equalScalar(series[p], await reader.value(kind, id, variable, p)), `${kind}/${variable} value != series`);
      const obj = await reader.objectResult(kind, id, p);
      assert.ok(obj.length > 0);
      const codes = reader.columns(kind);
      const code = { node: 0, link: 0, subcatch: 4 }[kind];
      const col = codes.indexOf(code);
      assert.ok(col >= 0, `Missing ${kind}.${variable} code`);
      assert.ok(equalScalar(obj[col], series[p]), 'objectResult != series');
      const snap = await reader.snapshot(kind, variable, p);
      assert.equal(snap.length, count);
      assert.ok(equalScalar(snap[0], series[p]), 'snapshot != series');
      probes.push({ kind, id, first: series[0], middle: series[p] });
    }
    result.out = { bytes: testCase.outSize, version: reader.info.version, periods, reportStep: reader.info.reportStepSeconds, probes };
  } finally {
    await handle.close();
  }
  result.totalMs = Math.round((performance.now() - start) * 100) / 100;
  return result;
}

await mkdir(dataDir, { recursive: true });
const subset = cases.filter(c => selection === 'stress' || (selection === 'large' ? c.group !== 'stress' : c.group === 'standard'));
let passed = 0, failed = 0;
for (const fixture of subset) {
  try {
    const report = await run(fixture);
    console.log('PASS ' + JSON.stringify(report));
    passed++;
  } catch (e) {
    console.error('FAIL ' + fixture.name + ': ' + (e?.stack || e));
    failed++;
  }
}
console.log(`COMPLETE passed=${passed} failed=${failed} source=${dataDir}`);
if (failed) process.exitCode = 1;
