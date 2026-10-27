#!/usr/bin/env node
/** Validate .out against independent EPA Output API measurements.
 * Does NOT generate its own reference values (that would not be independent).
 * Usage: node tools/compare-reference.mjs model.out reference.json
 */
import { open, readFile, stat } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { OutReader, FileHandleSource } from '../dist/index.js';
const [file, refFile] = process.argv.slice(2);
if (!file || !refFile) { console.error('Usage: node tools/compare-reference.mjs model.out ref.json'); process.exit(2); }
const reference=JSON.parse(await readFile(refFile,'utf8'));
assert.ok(Array.isArray(reference.checks) && reference.checks.length>0, 'Missing independent reference checks');
const handle=await open(file,'r');
try {
 const reader=await OutReader.open(new FileHandleSource((await stat(file)).size,handle));
 let count=0,maxAbs=0;
 for(const check of reference.checks){
  const values=await reader.series(check.kind,check.object,check.attribute,0,check.values.length);
  for(let i=0;i<values.length;i++){
   const expected=check.values[i],actual=values[i];
   const diff=Math.abs(expected-actual);maxAbs=Math.max(maxAbs,diff);
   const epsilon=1e-6*Math.max(1,Math.abs(expected));
   assert.ok((Number.isNaN(expected)&&Number.isNaN(actual)) || diff<=epsilon,
    `${check.kind} ${check.object} ${check.attribute} period ${i}: actual ${actual}, expected ${expected}`);
   count++;
  }
 }
 console.log(JSON.stringify({success:true,source:reference.origin,checks:count,maxAbsoluteError:maxAbs},null,2));
}finally{await handle.close()}
