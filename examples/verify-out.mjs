/**
 * Run against a real SWMM5 .out file (preferably paired with SWMM's .rpt).
 * Checks structural consistency and agreement across independently chosen query paths.
 * This does NOT compare values with EPA's native output API; see README.
 *
 * Usage: node examples/verify-out.mjs path/to/model.out [path/to/model.rpt]
 */
import { open, stat, readFile } from 'node:fs/promises';
import { FileHandleSource, OutReader, RptDocument } from '../dist/index.js';

const filename = process.argv[2];
const rptFilename = process.argv[3];
if (!filename) {
  console.error('Usage: node examples/verify-out.mjs model.out [model.rpt]');
  process.exitCode = 2;
} else {
  const handle = await open(filename, 'r');
  try {
    const fileSize = (await stat(filename)).size;
    const out = await OutReader.open(new FileHandleSource(fileSize, handle), { allowSimulationErrors: true });
    const { info } = out;
    console.log(JSON.stringify(info, null, 2));
    for (const [kind, count] of [['subcatch',info.nSubcatch],['node',info.nNodes],['link',info.nLinks]]) {
      const ids = await out.ids(kind);
      if (ids.length !== count) throw new Error(`Count mismatch for ${kind}`);
      const props = await out.properties(kind);
      console.log(`${kind}: ${count} reportable objects; ${props.codes.length} static properties`);
      if (count === 0 || info.periods === 0 || out.columns(kind).length === 0) continue;
      // Endpoints and middle periods. Check three distinct reader paths.
      const periods = [...new Set([0,Math.floor(info.periods/2),info.periods-1])];
      const series = await out.series(kind, 0, out.columns(kind)[0]);
      for (const p of periods) {
        const scalar = await out.value(kind, 0, out.columns(kind)[0], p);
        const vector = await out.objectResult(kind,0,p);
        if (!Object.is(scalar,series[p]) || !Object.is(scalar,vector[0])) {
          throw new Error(`Query paths disagree: ${kind} period ${p}`);
        }
      }
      console.log(`  First element: ${ids[0]}; cross-check OK`);
    }
    const timestamps = await out.timestampsSerial(0,Math.min(2,info.periods));
    for (const t of timestamps) if (!Number.isFinite(t)) throw new Error('Invalid report timestamp');
    if (rptFilename) {
      const report = RptDocument.parse(await readFile(rptFilename,'utf8'));
      console.log(`RPT: ${report.errors.length} errors, ${report.warnings.length} warnings`);
      for (const [name, err] of report.continuityErrors()) console.log(`  ${name}: ${err}%`);
    }
    console.log('Structural and internal value cross-checks passed. EPA-native numerical parity NOT established.');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await handle.close();
  }
}
