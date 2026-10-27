/** Runnable v0.6.0 example without network access. */
import { InpModel } from '../dist/index.js';
const inp=`[RAINGAGES]
RG INTENSITY 0:05 1.0 TIMESERIES T
[JUNCTIONS]
N1 0 2
N2 0 2
[CONDUITS]
C1 N1 N2 100 0.013 0 0
C2 N2 BAD 200 0.014 0 0
[XSECTIONS]
C1 CIRCULAR 1 0 0 0 1
C2 CIRCULAR 1 0 0 0 1
`;
const model=InpModel.parse(inp,{mode:'lazy',maxBytes:32*1024*1024});
const ids=['C2','C1'];
console.log('Batch',model.properties.getMany('CONDUITS',ids,['length','roughness']));
console.log('Numeric',model.properties.numericMany('CONDUITS',ids,['length']).columns[0]);
model.properties.materialize('CONDUITS',['length']);
console.log('Cached',model.properties.numericMany('CONDUITS',ids,['length']).columns[0]);
console.log('Diagnostics',model.validate({level:'full'}));
