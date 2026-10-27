import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InpModel, InpDocument, inpSchema, inpSchemas, OutReader, MemorySource } from '../dist/index.js';
import { createPollutantOut } from './fixture-pollutants.mjs';

const inp = `[TITLE]\r\nExample\r\n[OPTIONS]\r\nFLOW_UNITS CMS\r\nINFILTRATION GREEN_AMPT\r\n[CONDUITS]\r\nC1 J1 J2 120.5 0.013 1.25 0 0 0 ;keep\r\nC2 J2 J3 200 0.016 * *\r\n[XSECTIONS]\r\nC1 CIRCULAR 1.5 0 0 0 2\r\nC2 IRREGULAR transect4\r\n[OUTFALLS]\r\nO1 100 FREE YES\r\nO2 103 FIXED 104.2 NO\r\n[STORAGE]\r\nST1 10 3 0 FUNCTIONAL 2.5 1.2 5 0 1\r\nST2 10 4 0 TABULAR AC1 0 0\r\n[INFILTRATION]\r\nS1 10 2 0.4\r\n[LID_CONTROLS]\r\nBIO BC\r\nBIO SURFACE 5 0.2 0.1 0.02 3\r\nBIO SOIL 10 0.45 0.2 0.1 0.5 2 4\r\n[TIMESERIES]\r\n"Rain A" 01/01/2001 00:00 2\r\n"Rain A" 01/01/2001 00:05 4\r\n[EXTENSION_X]\r\nkey 20 30\r\n`;

test('INP named and raw property access preserves text/comments/CRLF', () => {
  const model = InpModel.parse(inp);
  const p = model.properties;
  assert.equal(model.document.toString(), inp);
  assert.equal(p.get('CONDUITS','C1','length'),120.5);
  assert.equal(p.get('CONDUITS','C1','roughness'),0.013);
  assert.equal(p.get('CONDUITS','C1','inletOffset'),1.25);
  assert.equal(p.get('CONDUITS','C2','outletOffset'),'*');
  assert.equal(p.raw('CONDUITS','C1',7),'0');
  assert.equal(p.get('XSECTIONS','C1','geometry1'),1.5);
  assert.equal(p.get('XSECTIONS','C1','barrels'),2);
  assert.equal(p.get('XSECTIONS','C2','transect'),'transect4');
  assert.equal(p.get('OUTFALLS','O1','gated'),'YES');
  assert.equal(p.get('OUTFALLS','O2','gated'),'NO');
  assert.equal(p.get('OUTFALLS','O2','stageData'),'104.2');
  assert.equal(p.get('STORAGE','ST1','areaExponent'),1.2);
  assert.equal(p.get('STORAGE','ST2','areaCurve'),'AC1');
  assert.equal(p.get('INFILTRATION','S1','hydraulicConductivity'),2);
  assert.equal(p.get('INFILTRATION','S1','initialDeficit'),0.4);
  assert.equal(p.layer('BIO','SURFACE').storageHeight,5);
  assert.equal(p.layer('BIO','SOIL').suctionHead,4);
  assert.equal(p.layer('BIO','DRAIN'),undefined);
  assert.equal(p.record('CONDUITS','C1').outletOffset,0);
  assert.equal(p.record('CONDUITS','C99'),undefined);
});

test('INP duplicate records, unknown sections, schema declarations, numeric columns', () => {
  const doc = InpDocument.parse(inp);
  const model = new InpModel(doc);
  assert.equal([...doc.rowsById('TIMESERIES','Rain A')].length,2);
  assert.equal(doc.rowById('TIMESERIES','Rain A').fields[3],'2');
  assert.equal(model.properties.raw('EXTENSION_X','key',2),'30');
  assert.throws(()=>model.properties.get('EXTENSION_X','key','anything'),/schema/);
  const col=model.properties.numericColumn('CONDUITS','length');
  assert.deepEqual(col.ids,['C1','C2']);
  assert.deepEqual([...col.values],[120.5,200]);
  const missing=model.properties.numericColumn('CONDUITS','outletOffset');
  assert.deepEqual([...missing.values],[0,NaN]);
  assert.ok(inpSchema('CONDUITS'));
  assert.ok(inpSchemas().length>=40);
  assert.throws(()=>model.properties.get('CONDUITS','C1','missing'),/Unknown/);
  assert.throws(()=>model.properties.raw('CONDUITS','C1',-1),RangeError);
  assert.throws(()=>model.properties.numericColumn('CONDUITS','fromNode'),TypeError);
});

test('INP strict numeric conversion rejects malformed literals rather than misreading', () => {
  const model=InpModel.parse('[CONDUITS]\nC1 J1 J2 7oops 0.013 0 0');
  assert.throws(()=>model.properties.get('CONDUITS','C1','length'),/Invalid/);
  assert.equal(model.properties.raw('CONDUITS','C1',3),'7oops');
});

test('OUT names every static stored property and handles duplicate code 4 offsets', async () => {
  const out=await OutReader.open(new MemorySource(createPollutantOut({periods:3})));
  const link=await out.properties('link');
  assert.deepEqual(link.names,['type','inletOffset','outletOffset','maxDepth','length']);
  assert.equal(link.getNamed(0,'inletOffset'),1);
  assert.equal(link.getNamed(0,'outletOffset'),2);
  assert.equal(link.getNamed(0,'length'),link.get(0,5));
  assert.equal(await out.propertyValue('link','L1','length'),50);
  assert.equal(await out.propertyValue('node','J2','invertElevation'),11);
  assert.equal((await out.properties('subcatch')).getNamed(0,'area'),12.5);
  assert.throws(()=>link.getNamed(0,'nope'),RangeError);
  assert.throws(()=>link.getNamed(1,'length'),RangeError);
  const vars=await out.columnNames('link');
  assert.equal(vars[0].name,'flow');
  assert.equal(vars[5].name,'pollutant:TSS');
  assert.equal(vars[0].code,0);
});
