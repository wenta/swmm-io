/** Usage: node examples/inspect.mjs model.inp [results.out] [report.rpt] */
import { readFile, open, stat } from 'node:fs/promises';
import { InpModel, OutReader, FileHandleSource, RptDocument } from '../dist/index.js';

const [input, output, report] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node examples/inspect.mjs model.inp [results.out] [report.rpt]');
  process.exitCode = 1;
} else {
  const model = InpModel.parse(await readFile(input,'utf8'));
  const graph = model.topology();
  console.log('Input:', {nodes: graph.nodes.size, links: graph.links.size, dangling: graph.dangling});
  if (output) {
    const handle = await open(output,'r');
    try {
      const reader = await OutReader.open(new FileHandleSource((await stat(output)).size,handle));
      console.log('Results:', reader.info);
      const ids = await reader.ids('link');
      if (ids.length) {
        const flow = await reader.series('link', ids[0], 'flow', 0, Math.min(reader.info.periods, 10));
        console.log('First 10 flows of', ids[0], Array.from(flow));
      }
    } finally { await handle.close(); }
  }
  if (report) {
    const rpt = RptDocument.parse(await readFile(report,'utf8'));
    console.log('Report errors:', rpt.errors, 'warnings:', rpt.warnings);
    console.log('Continuity errors:', Object.fromEntries(rpt.continuityErrors()));
  }
}
