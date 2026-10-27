#!/usr/bin/env node
/**
 * Node-only diagnostic CLI for genuine .inp/.out files. No changes are made to
 * the input model. For reproducible peak RSS on macOS run with:
 *   /usr/bin/time -l node --expose-gc tools/measure-model.mjs --inp MODEL.inp
 * For Linux peak RSS use /usr/bin/time -v instead. JS heap excludes native and
 * ArrayBuffer memory; capture both RSS and arrayBuffers.
 */
import { open, readFile, writeFile, stat, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { InpModel, OutReader, FileHandleSource, OutSeriesIndex } from '../dist/index.js';

function usage() {
  console.error('Usage: node tools/measure-model.mjs --inp <path> | --out <path> [--index] [--index-file <path>] [--source-key <verified-immutable-id> | --trust-stat-key] [--max-index-mib <number>]');
  process.exitCode=2;
}
function argsOf(tokens) {
  const options={};
  for(let i=0;i<tokens.length;i++) {
    const k=tokens[i];
    if(k==='--index') options.index=true;
    else if(k==='--trust-stat-key') options.trustStatKey=true;
    else if(['--inp','--out','--index-file','--source-key','--max-index-mib'].includes(k)) {
      if(!tokens[i+1]) throw new Error(`Missing value after ${k}`);
      options[k.slice(2)]=tokens[++i];
    } else throw new Error(`Unknown argument ${k}`);
  }
  if(Boolean(options.inp)===Boolean(options.out)) throw new Error('Supply exactly one of --inp and --out');
  if(options.trustStatKey && options['source-key']) throw new Error('Choose --source-key OR --trust-stat-key');
  return options;
}
const round=x=>Math.round(x*1000)/1000;
const memory=()=>{
  const m=process.memoryUsage();
  return {rssMiB:round(m.rss/2**20), heapMiB:round(m.heapUsed/2**20),
    externalMiB:round(m.external/2**20),arrayBufferMiB:round(m.arrayBuffers/2**20)};
};
/** Full-file SHA-256 with one reused 1 MiB buffer. O(1) temporary bytes.
 * Uses the same open file descriptor as the reader, avoiding file replacement
 * races between distinct opens. It still reads all bytes: this is intentional.
 */
async function digest(file,path){
  const before=await file.stat({bigint:true});
  const beforePath=await stat(path,{bigint:true});
  if(before.dev!==beforePath.dev || before.ino!==beforePath.ino)
    throw new Error('Source path is not the open file');
  const hash=createHash('sha256');
  const scratch=Buffer.allocUnsafe(1024*1024);
  for(let position=0n;position<before.size;){
    const request=Number((before.size-position)>BigInt(scratch.length)?BigInt(scratch.length):(before.size-position));
    // Node's file handle supports safe integer positions; file is much smaller
    // than the JS safe-integer limit for these model benchmarks.
    const {bytesRead}=await file.read(scratch,0,request,Number(position));
    if(bytesRead===0) throw new Error('Unexpected end of file while hashing');
    hash.update(scratch.subarray(0,bytesRead));
    position+=BigInt(bytesRead);
  }
  const after=await file.stat({bigint:true});
  const afterPath=await stat(path,{bigint:true});
  if(before.size!==after.size || before.mtimeNs!==after.mtimeNs || before.ctimeNs!==after.ctimeNs ||
     before.dev!==after.dev || before.ino!==after.ino ||
     afterPath.dev!==after.dev || afterPath.ino!==after.ino)
    throw new Error('Source changed while computing SHA-256');
  return `sha256:${hash.digest('hex')}`;
}
/** Fast metadata identity: explicitly opt-in, NOT a content hash.
 * Suitable only when the caller controls file immutability.
 */
async function trustedStatKey(path){
  const s=await stat(path,{bigint:true});
  const canonical=await realpath(path);
  const fields=[canonical,s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String);
  return `trusted-stat-v1:${createHash('sha256').update(JSON.stringify(fields)).digest('hex')}`;
}
async function main(){
  let args;
  try{args=argsOf(process.argv.slice(2));}catch(error){console.error(error.message);usage();return;}
  const measurements=[];
  const mark=(stage,ms=null,extra={})=>measurements.push({stage, ...(ms===null?{}:{ms:round(ms)}), ...memory(),...extra});
  mark('start');
  if(args.inp){
    const start=performance.now();
    const text=await readFile(args.inp,'utf8');
    mark('read text',performance.now()-start,{chars:text.length});
    const before=performance.now();
    const model=InpModel.parse(text);
    mark('parse/index sections',performance.now()-before,{sections:model.document.sections.length});
    const t=performance.now();
    const topology=model.topology();
    mark('build topology',performance.now()-t,{nodes:topology.nodes.size,links:topology.links.size,dangling:topology.dangling.length});
  } else {
    const path=args.out;
    const file=await open(path,'r');
    const size=(await stat(path)).size;
    const reader=await OutReader.open(new FileHandleSource(size,file));
    try{
      mark('open output metadata',null,{bytes:size,info:reader.info});
      const t0=performance.now();
      const links=await reader.ids('link');
      mark('read object IDs',performance.now()-t0,{linkCount:links.length});
      if(!links.length) throw new Error('This CLI benchmark requires at least one link');
      const req={kind:'link',object:links[0],attribute:'flow'};
      const ts=performance.now();
      const raw=await reader.seriesEnvelope(req.kind,req.object,req.attribute,0,reader.info.periods,1000);
      mark('raw first seriesEnvelope',performance.now()-ts,{points:raw.values.length});
      if(args.index){
        const keyStart=performance.now();
        const sourceKey=args['source-key'] || (args.trustStatKey ? await trustedStatKey(path) : await digest(file,path));
        mark('resolve source key',performance.now()-keyStart, {keyPrefix:sourceKey.slice(0,16),
          identityMode: args['source-key'] ? 'application-managed' : args.trustStatKey ? 'trusted-stat (NOT content-verified)' : 'full-sha256'});
        const indexBudget=args['max-index-mib'] ? Number(args['max-index-mib'])*1024*1024 : 256*1024*1024;
        const indexFile=args['index-file'];
        let index;let restored=false;
        if(indexFile){
          try{
            const bytes=await readFile(indexFile);
            const tl=performance.now();
            index=OutSeriesIndex.restore(reader,bytes,{sourceKey,expectedRequest:req,maxIndexBytes:indexBudget});
            mark('restore index',performance.now()-tl,{sidecarBytes:bytes.length});
            restored=true;
          } catch(error) {
            if(error?.code!=='ENOENT') throw error;
          }
        }
        if(!restored){
          const tb=performance.now();
          index=await OutSeriesIndex.build(reader,req,{sourceKey,maxIndexBytes:indexBudget});
          mark('build index',performance.now()-tb,{indexBytes:index.indexBytes});
          if(indexFile){
            const tw=performance.now();
            const bytes=index.serialize();
            await writeFile(indexFile,bytes,{flag:'wx'});
            mark('write index sidecar',performance.now()-tw,{sidecarBytes:bytes.length});
          }
        }
        const tc=performance.now();
        const indexed=index.envelope(0,reader.info.periods,1000);
        mark('cached chart query',performance.now()-tc,{points:indexed.values.length});
        if(raw.values.length!==indexed.values.length || raw.periods.some((v,i)=>v!==indexed.periods[i]) ||
           raw.values.some((v,i)=>!Object.is(v,indexed.values[i]))) throw new Error('Index did not reproduce the raw envelope');
      }
    }finally{await reader.close();}
  }
  console.log(JSON.stringify({node:process.version,platform:process.platform,arch:process.arch,measurements},null,2));
}
await main().catch(err=>{console.error(err);process.exitCode=1});
