/** Smoke-install the exact packed npm artifact in a clean ESM consumer. */
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const work = await mkdtemp(join(tmpdir(), 'swmm-io-pack-'));
const env = { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' };
function run(program, args, dir = work) {
  return execFileSync(program, args, { cwd: dir, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
try {
  const file = run('npm', ['pack','--ignore-scripts','--silent','--pack-destination',work], cwd).split('\n').at(-1);
  if (!file?.endsWith('.tgz')) throw new Error(`npm pack returned invalid filename: ${file}`);
  await writeFile(join(work,'package.json'), '{"name":"smoke-consumer","private":true,"type":"module"}\n');
  run('npm', ['install','--offline','--ignore-scripts','--no-audit','--no-fund',join(work,file)]);
  const output = run('node',['--input-type=module','-e', String.raw`
    import assert from 'node:assert/strict';
    import {OutReader, InpModel, BlobSource} from 'swmm-io';
    assert.equal(typeof OutReader.open, 'function');
    assert.equal(typeof InpModel.parse, 'function');
    assert.deepEqual([...await new BlobSource(new Blob([new Uint8Array([7,8,9])])).read(1,2)],[8,9]);
    console.log('ESM consumer import and Blob read: OK');
  `]);
  console.log(JSON.stringify({packed:file,consumer:output}));
} finally {
  await rm(work,{recursive:true,force:true});
}
