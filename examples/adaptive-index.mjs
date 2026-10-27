/**
 * swmm-io v0.7.1, minimal Node demo using a real SWMM .out file:
 *   node examples/adaptive-index.mjs path/to/model.out SHA256_SOURCE_KEY
 * Key must be a verified immutable source identity (not just a filename).
 */
import {open,stat} from 'node:fs/promises';
import {FileHandleSource,OutReader,OutIndexCache,AdaptiveOutIndex} from '../dist/index.js';
const path=process.argv[2],sourceKey=process.argv[3];
if(!path||!sourceKey){console.error('Usage: node examples/adaptive-index.mjs FILE.out VERIFIED_SOURCE_KEY');process.exit(2);}
const handle=await open(path,'r');
try{
  const out=await OutReader.open(new FileHandleSource((await stat(path)).size,handle));
  const ids=await out.ids('link');
  if(!ids.length)throw Error('No links in model');
  const cache=new OutIndexCache({maxBytes:64*1024*1024,maxEntries:8});
  const query=new AdaptiveOutIndex(cache);
  const request={kind:'link',object:ids[0],attribute:'flow'};
  for(let i=0;i<8;i++){
    const result=await query.envelope(out,request,sourceKey,0,out.info.periods,1000);
    console.log({query:i+1,mode:result.mode,points:result.series.periods.length,cache:cache.stats()});
  }
}finally{await handle.close();}
