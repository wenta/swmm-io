import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InpModel, InpDocument } from '../dist/index.js';

const input = `\ufeff[TITLE]\r\nSWMM Cache\r\n[CONDUITS]\r\n"C 1" N1 N2 15.5 0.014 2 * ; first\r\nC2 N2 N3 20 0.015 0 1\r\nC3 N3 N4 35 0.016 0\r\nC4 N4 N5 40 0.017 2 3\r\n[OPTIONS]\r\nFLOW_UNITS CMS\r\n[CONDUITS]\r\nC5 N5 N6 50 0.018 3 4\r\n"C 1" N1 N2 999 0.019 0 1 ; duplicate\r\n[XSECTIONS]\r\nC2 IRREGULAR transectA\r\n`;

// 0.5 public cache calls must retain observable 0.4 parser semantics.
test('manual columns preserve exact values, quoted IDs, duplicates, missing and *', () => {
  const model = InpModel.parse(input, {maxBytes: 1024});
  const p = model.properties;
  const before = ['C 1', 'C2', 'C3', 'C4', 'C5'].map(id=>p.get('CONDUITS',id,'length'));
  assert.equal(model.document.sectionRowCount('CONDUITS'), 6);
  assert.equal(model.document.rowPosition('CONDUITS','C 1'), 0);
  assert.equal(model.document.rowPosition('CONDUITS','C5'), 4);
  const built=p.materialize('CONDUITS',['length','roughness','outletOffset','length']);
  assert.deepEqual(built.newFields,['length','roughness','outletOffset']);
  assert.equal(built.addedBytes,6*3*8);
  assert.equal(p.cacheStats().usedBytes,144);
  assert.deepEqual(['C 1', 'C2', 'C3', 'C4', 'C5'].map(id=>p.get('CONDUITS',id,'length')), before);
  assert.equal(p.get('CONDUITS','C 1','outletOffset'),'*');
  assert.equal(p.get('CONDUITS','C3','outletOffset'),undefined);
  assert.equal(p.get('CONDUITS','MISSING','length'),undefined);
  assert.deepEqual([...p.cachedColumn('CONDUITS','outletOffset')], [NaN,1,NaN,3,4,1]);
  assert.equal(p.cachedColumn('CONDUITS','length').length,6);
  const col=p.numericColumn('CONDUITS','length');
  assert.deepEqual([...col.values],[15.5,20,35,40,50,999]);
  assert.deepEqual(col.ids,['C 1','C2','C3','C4','C5','C 1']);
  // Copies cannot corrupt the internal cache.
  col.values[0]=-99;
  const copy=p.cachedColumn('CONDUITS','length');copy[0]=-88;
  assert.equal(p.get('CONDUITS','C 1','length'),15.5);
  assert.equal(model.document.toString(),input);
  assert.ok(p.cacheStats().hits>=5);
  assert.deepEqual(p.materialize('CONDUITS',['length']).newFields,[]);
  assert.equal(p.evict('CONDUITS',['roughness']),48);
  assert.equal(p.cacheStats().columns,2);
  assert.equal(p.evict(),96);
  assert.equal(p.cacheStats().usedBytes,0);
  assert.equal(p.get('CONDUITS','C 1','length'),15.5);
});

test('build is transactional, capacity bound and rejects unsafe variant or text fields', () => {
  const small=InpModel.parse(input,{maxBytes:6*8});
  const p=small.properties;
  assert.throws(()=>p.materialize('CONDUITS',['length','roughness']),/budget/);
  assert.equal(p.cacheStats().usedBytes,0);
  assert.deepEqual(p.materialize('CONDUITS',['length']).newFields,['length']);
  assert.throws(()=>p.materialize('CONDUITS',['roughness']),/budget/);
  assert.equal(p.cacheStats().columns,1);
  assert.throws(()=>p.materialize('CONDUITS',['fromNode']),/not a numeric/);
  assert.throws(()=>p.materialize('XSECTIONS',['geometry1']),/variant/);
  assert.throws(()=>p.materialize('NOPE',['length']),/schema/);
  assert.throws(()=>p.materialize('CONDUITS',['nope']),/Unknown/);
  assert.equal(p.cacheStats().usedBytes,48);
  const broken=InpModel.parse('[CONDUITS]\nC1 N1 N2 15 0.01\nC2 N2 N3 BAD 0.02');
  assert.throws(()=>broken.properties.materialize('CONDUITS',['roughness','length']),/Invalid/);
  assert.equal(broken.properties.cacheStats().columns,0);
  assert.equal(broken.properties.cacheStats().usedBytes,0);
  assert.equal(broken.properties.get('CONDUITS','C1','length'),15);
  assert.throws(()=>broken.properties.get('CONDUITS','C2','length'),/Invalid/);
});

test('auto mode promotes individual hot fixed fields after threshold; evict returns to lazy', () => {
  const model=InpModel.parse(input,{mode:'auto',maxBytes:6*8*2,minPromotionReads:3,promotionRatio:0.01});
  const p=model.properties;
  assert.equal(p.get('CONDUITS','C2','length'),20);
  assert.equal(p.get('CONDUITS','C2','length'),20);
  assert.equal(p.cacheStats().columns,0);
  assert.equal(p.get('CONDUITS','C2','length'),20);
  assert.deepEqual(p.cacheStats().cached.map(x=>x.field),['length']);
  assert.equal(p.get('CONDUITS','C2','length'),20);
  assert.equal(p.cacheStats().autoPromotions,1);
  assert.equal(p.get('CONDUITS','C2','roughness'),0.015);
  assert.equal(p.get('CONDUITS','C2','roughness'),0.015);
  assert.equal(p.get('CONDUITS','C2','roughness'),0.015);
  assert.equal(p.cacheStats().columns,2);
  assert.equal(p.get('CONDUITS','C2','outletOffset'),1);
  assert.equal(p.get('CONDUITS','C2','outletOffset'),1);
  assert.equal(p.get('CONDUITS','C2','outletOffset'),1);
  assert.equal(p.cacheStats().columns,2); // Budget prevents promotion.
  assert.equal(p.evict('CONDUITS',['roughness']),48);
  for(let i=0;i<3;i++)assert.equal(p.get('CONDUITS','C2','outletOffset'),1);
  assert.equal(p.cacheStats().columns,2);
  assert.deepEqual(p.cacheStats().cached.map(x=>x.field),['length','outletOffset']);
});

test('auto remains opt-in; invalid configuration fails early', () => {
  const standard=InpModel.parse(input);
  for(let i=0;i<500;i++) standard.properties.get('CONDUITS','C2','length');
  assert.equal(standard.properties.cacheStats().columns,0);
  for(const opts of [{mode:'oops'}, {maxBytes:-1}, {maxBytes:1.1},{minPromotionReads:0}, {promotionRatio:0}]) {
    assert.throws(()=>InpModel.parse(input,opts));
  }
  assert.throws(()=>standard.properties.evict(undefined,['length']),/section/);
  assert.equal(standard.properties.cachedColumn('CONDUITS','length'),undefined);
  assert.equal(standard.properties.borrowColumn('CONDUITS','length'),undefined);
  assert.equal(standard.document.sectionRowCount('NOT_PRESENT'),0);
  assert.equal(standard.document.rowPosition('NOT_PRESENT','id'),undefined);
});

test('cached columns never survive immutable source editing', () => {
  const first=InpModel.parse('[CONDUITS]\nC1 A B 10 0.01');
  first.properties.materialize('CONDUITS',['length']);
  const second=new InpModel(first.document.replaceRow('CONDUITS','C1',['C1','A','B','42','0.01']));
  assert.equal(first.properties.get('CONDUITS','C1','length'),10);
  assert.equal(second.properties.get('CONDUITS','C1','length'),42);
  assert.equal(second.properties.cacheStats().columns,0);
});

test('selected scanner handles quoting, semicolon comments and duplicate positions', () => {
  const doc=InpDocument.parse('[CONDUITS]\n"C 1" "Node; A" N2 18 0.01 ; end\n[CONDUITS]\nC2 N2 N3 19 0.02\n');
  const found=[];
  doc.forEachSelectedFields('CONDUITS',[3,0,3,4],(row,id,fields)=>{
    found.push({row,id,fields:[...fields]});
  });
  assert.deepEqual(found,[
    {row:0,id:'C 1',fields:['18','C 1','18','0.01']},
    {row:1,id:'C2',fields:['19','C2','19','0.02']}
  ]);
  assert.throws(()=>doc.forEachSelectedFields('CONDUITS',[-1],()=>{}),RangeError);
});

test('automatic promotion never surfaces malformed data from an unrelated record', () => {
  const model=InpModel.parse('[CONDUITS]\nC1 A B 1 0.01\nC2 B C bad 0.02', {
    mode:'auto',minPromotionReads:2,promotionRatio:0.01
  });
  assert.equal(model.properties.get('CONDUITS','C1','length'),1);
  assert.equal(model.properties.get('CONDUITS','C1','length'),1);
  assert.equal(model.properties.cacheStats().columns,0);
  assert.throws(()=>model.properties.get('CONDUITS','C2','length'),/Invalid/);
});
