/** No file downloads required. Run after `npm run build`: `node examples/hybrid-cache.mjs`. */
import { InpModel } from '../dist/index.js';

const inp = `[OPTIONS]\nFLOW_UNITS CMS\n[CONDUITS]\nC1 J1 J2 120 0.013 0 0\nC2 J2 J3 140 0.014 * 1\nC3 J3 J4 160 0.015 2 3\n`;
const model = InpModel.parse(inp,{mode:'auto',maxBytes:1024,minPromotionReads:2,promotionRatio:0.01});
const p = model.properties;
console.log('Cold:',p.get('CONDUITS','C1','length'));
console.log('Promoting hot length:',p.get('CONDUITS','C2','length'));
console.log('Hot:',p.get('CONDUITS','C3','length'));
console.log('Manual other fields:',p.materialize('CONDUITS',['roughness','inletOffset']));
console.log('Sentinel preserved:',p.get('CONDUITS','C2','inletOffset'));
console.log('Stats:',p.cacheStats());
console.log('Copy:',p.cachedColumn('CONDUITS','length'));
console.log('Freed bytes:',p.evict());
console.log('Still readable:',p.get('CONDUITS','C1','length'));
