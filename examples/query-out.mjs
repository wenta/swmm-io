/** Inspect and query a local EPA SWMM .out using only the public package API. */
import { open, stat } from 'node:fs/promises';
import { OutReader, FileHandleSource } from '../dist/index.js';

const path=process.argv[2];
if(!path) {
  console.error('Usage: node examples/query-out.mjs /path/to/model.out');
  process.exitCode=2;
} else {
  const handle=await open(path,'r');
  try {
    const source=new FileHandleSource((await stat(path)).size,handle);
    const out=await OutReader.open(source);
    const ids=await out.ids('link');
    const objects=ids.slice(0,Math.min(3,ids.length));
    const spec={kind:'link',objects,attributes:['flow','depth'],periods:{from:0,to:Math.min(120,out.info.periods)}};
    console.log('Model:',out.info);
    if(!objects.length){console.log('No links');}
    else {
      console.log('Plan:',await out.explainQuery(spec));
      const result=await out.query(spec);
      console.log('Flow of first link:',Array.from(result.column(0).subarray(0,5)));
      const stats=await out.aggregateMany(spec,{chunkPeriods:16,maxOutputBytes:1024*1024});
      console.log('Means:',Array.from(stats.mean));
      let chunks=0, total=0;
      for await(const batch of out.queryStream(spec,{chunkPeriods:25,maxOutputBytes:1024*1024})){
        chunks++;total+=batch.periodCount;
      }
      console.log('Streaming:',{chunks,totalPeriods:total});
    }
  } finally {await handle.close();}
}
