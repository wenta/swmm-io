import { InpDocument, type InpRow } from './inp.js';

/** Diagnostic severity. Parsing is lossless: validation never modifies the file. */
export type DiagnosticSeverity = 'error' | 'warning';
export interface InpDiagnostic {
  readonly severity: DiagnosticSeverity;
  readonly code: string;
  readonly section: string;
  readonly line: number;
  readonly id?: string;
  readonly message: string;
}
export interface InpValidationOptions {
  /** basic validates IDs and topology; full also checks selected numeric fields and hydrology references. */
  readonly level?: 'basic' | 'full';
  /** Bounds memory and output on deeply damaged inputs; default 1,000. */
  readonly maxIssues?: number;
}

const NODES = ['JUNCTIONS', 'OUTFALLS', 'STORAGE', 'DIVIDERS'] as const;
const LINKS = ['CONDUITS', 'PUMPS', 'ORIFICES', 'WEIRS', 'OUTLETS'] as const;

/**
 * A streaming, deliberately conservative static validator for standard SWMM INP.
 * It does not run the hydraulic solver, check unit-dependent hydraulic constraints,
 * or claim to replace EPA's native input validation. Unsupported vendor sections
 * remain readable and are not treated as errors.
 *
 * Complexity: O(N) source traversal plus O(nodes + links + subcatchments) ID
 * memory. No full graph, coordinate objects, or numeric column caches are built.
 */
export function validateInp(document: InpDocument, options: InpValidationOptions = {}): readonly InpDiagnostic[] {
  const { level = 'basic', maxIssues = 1000 } = options;
  if (level !== 'basic' && level !== 'full') throw new RangeError('Invalid validation level');
  if (!Number.isSafeInteger(maxIssues) || maxIssues < 1) throw new RangeError('maxIssues must be a positive safe integer');
  const results: InpDiagnostic[] = [];
  const report = (severity: DiagnosticSeverity, code: string, section: string, line: number, message: string, id?: string) => {
    if (results.length < maxIssues) results.push({ severity, code, section, line, ...(id === undefined ? {} : { id }), message });
  };
  const nodes = new Map<string, InpRow>();
  const links = new Map<string, InpRow>();
  const subcatchments = new Map<string, InpRow>();
  const raingages = new Set<string>();
  for (const row of document.rows('RAINGAGES')) if (row.fields[0]) raingages.add(row.fields[0]);

  function addIdentity(table: Map<string, InpRow>, row: InpRow) {
    const id = row.fields[0];
    if (!id) { report('error','MISSING_ID',row.section,row.line,'Missing object identifier'); return; }
    const first = table.get(id);
    if (first) report('error','DUPLICATE_ID',row.section,row.line,`Duplicate object '${id}' (first defined at line ${first.line})`,id);
    else table.set(id,row);
  }
  for (const section of NODES) for (const row of document.rows(section)) {
    addIdentity(nodes,row);
    if (level === 'full') {
      validateNumber(row,1,'invertElevation',false,report);
      if (section === 'JUNCTIONS' || section === 'STORAGE') validateNumber(row,2,'maxDepth',true,report);
    }
  }
  for (const section of LINKS) for (const row of document.rows(section)) addIdentity(links,row);
  for (const row of document.rows('SUBCATCHMENTS')) addIdentity(subcatchments,row);
  for (const section of LINKS) for (const row of document.rows(section)) {
    const id = row.fields[0];
    for (const [index, name] of [[1,'from'],[2,'to']] as const) {
      const target = row.fields[index];
      if (!target || !nodes.has(target)) report('error','UNKNOWN_NODE',row.section,row.line,`Missing or unknown ${name} node '${target ?? ''}'`,id);
    }
    if (level === 'full' && section === 'CONDUITS') {
      validateNumber(row,3,'length',true,report,true);
      validateNumber(row,4,'roughness',true,report,true);
    }
  }
  if (level === 'full') {
    for (const row of document.rows('SUBCATCHMENTS')) {
      const [id, raingage, outlet] = row.fields;
      if (!raingage || !raingages.has(raingage)) report('error','UNKNOWN_RAINGAGE',row.section,row.line,`Unknown rain gage '${raingage ?? ''}'`,id);
      if (!outlet || !(nodes.has(outlet) || subcatchments.has(outlet))) report('error','UNKNOWN_OUTLET',row.section,row.line,`Unknown subcatchment outlet '${outlet ?? ''}'`,id);
      validateNumber(row,3,'area',true,report);
      const impervious = validateNumber(row,4,'imperviousPercent',true,report);
      if (impervious !== undefined && impervious > 100) report('error','OUT_OF_RANGE',row.section,row.line,'Impervious percent must not exceed 100',id);
    }
    const xsections = new Set<string>();
    for (const row of document.rows('XSECTIONS')) if (row.fields[0]) xsections.add(row.fields[0]);
    for (const row of document.rows('CONDUITS')) {
      const id = row.fields[0];
      if (id && !xsections.has(id)) report('error','MISSING_XSECTION',row.section,row.line,'Conduit has no XSECTIONS entry',id);
    }
  }
  return results;
}

function validateNumber(row: InpRow, index: number, label: string, nonnegative: boolean,
  emit: (severity: DiagnosticSeverity, code: string, section: string, line: number, message: string, id?: string) => void,
  positive = false): number | undefined {
  const raw = row.fields[index];
  const value = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  if (!Number.isFinite(value)) {
    emit('error','INVALID_NUMBER',row.section,row.line,`Invalid or missing ${label}: '${raw ?? ''}'`,row.fields[0]);
    return undefined;
  }
  if ((positive && value <= 0) || (nonnegative && value < 0))
    emit('error','OUT_OF_RANGE',row.section,row.line,`Invalid ${label}: ${value}`,row.fields[0]);
  return value;
}
