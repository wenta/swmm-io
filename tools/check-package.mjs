/** Release source checks; run before npm pack (Node-only, not part of runtime). */
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = file => readFile(join(root,file),'utf8');
const p = JSON.parse(await read('package.json'));
const lock = JSON.parse(await read('package-lock.json'));
assert.equal(p.name, 'swmm-io');
assert.equal(p.version, lock.version);
assert.equal(p.version, lock.packages[''].version);
assert.equal(p.type, 'module');
assert.equal(p.license, 'MIT');
assert.equal(Object.keys(p.dependencies || {}).length, 0, 'Runtime dependencies must remain empty');
assert.equal(p.publishConfig?.tag, 'beta', 'Prerelease must not publish as latest');
assert.match(p.version, /-beta\./);
assert.equal(p.devDependencies.typescript, lock.packages[''].devDependencies.typescript);
assert.equal(lock.packages['node_modules/typescript'].version, p.devDependencies.typescript);
assert.ok(lock.packages['node_modules/typescript'].integrity?.startsWith('sha512-'));
for (const file of ['README.md','LICENSE','CHANGELOG.md','dist/index.js','dist/index.d.ts','docs/RELEASING.md']) {
  const s = await stat(join(root,file)); assert.ok(s.size > 0, `${file} is empty`);
}
const dist = (await readdir(join(root,'dist'))).filter(x => x.endsWith('.js'));
assert.ok(dist.length >= 9, `Only ${dist.length} dist JS modules`);
for (const entry of dist) await stat(join(root,'dist',entry.replace(/\.js$/,'.d.ts')));
const js = await read('dist/index.js');
assert.ok(!/from ['"]node:/.test(js), 'Main module must not import Node built-ins');
const readme = await read('README.md');
assert.ok(readme.includes('out.ids(') && readme.includes('out.columnNames('),'README should teach model discovery');
for (const [whole,target] of readme.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
  if (/^(https?:|mailto:|#)/.test(target)) continue;
  await stat(join(root, target.split('#',1)[0])).catch(() => {throw new Error(`Broken README link: ${whole}`)});
}
console.log(JSON.stringify({ok:true, package:`${p.name}@${p.version}`, modules:dist.length, runtimeDependencies:0}));
