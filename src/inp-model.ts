import { InpDocument } from './inp.js';
import { InpProperties } from './inp-properties.js';
import type { ColumnCacheOptions } from './inp-column-store.js';
import { validateInp, type InpDiagnostic, type InpValidationOptions } from './inp-validator.js';

/** Typed views over common geometry sections. This does NOT silently validate the whole model. */
export type NodeKind = 'junction' | 'outfall' | 'storage' | 'divider';
export type LinkKind = 'conduit' | 'pump' | 'orifice' | 'weir' | 'outlet';
export interface SwmmNode {
  readonly id: string;
  readonly kind: NodeKind;
  readonly invertElevation: number;
  readonly line: number;
  readonly x?: number;
  readonly y?: number;
}
export interface SwmmLink {
  readonly id: string;
  readonly kind: LinkKind;
  readonly from: string;
  readonly to: string;
  readonly line: number;
  readonly length?: number;
  readonly roughness?: number;
}
export interface SwmmSubcatchment {
  readonly id: string;
  readonly rainGage: string;
  readonly outlet: string;
  readonly area: number;
  readonly imperviousPercent: number;
  readonly line: number;
}
export interface SwmmTopology {
  readonly nodes: ReadonlyMap<string, SwmmNode>;
  readonly links: ReadonlyMap<string, SwmmLink>;
  readonly incoming: ReadonlyMap<string, readonly string[]>;
  readonly outgoing: ReadonlyMap<string, readonly string[]>;
  readonly dangling: readonly string[];
}

function numeric(text: string | undefined, section: string, line: number, field: string): number {
  if (text === undefined || text.trim() === '' || !Number.isFinite(Number(text))) {
    throw new SyntaxError(`Invalid ${section}.${field} at line ${line}: ${text ?? '<missing>'}`);
  }
  return Number(text);
}

/** Lazily maps SWMM input rows to typed network objects; retains unknown sections untouched. */
export class InpModel {
  readonly properties: InpProperties;
  constructor(readonly document: InpDocument, cacheOptions: ColumnCacheOptions = {}) {
    this.properties = new InpProperties(document, cacheOptions);
  }

  /**
   * Parse without allocating data records or numeric columns. The optional
   * cache policy affects later property queries, NOT parse() startup cost.
   */
  static parse(source: string, cacheOptions: ColumnCacheOptions = {}): InpModel {
    return new InpModel(InpDocument.parse(source), cacheOptions);
  }

  /** Run a bounded, non-mutating structural/semantic validation on demand. */
  validate(options: InpValidationOptions = {}): readonly InpDiagnostic[] {
    return validateInp(this.document, options);
  }

  /** Options with normalized uppercase keys; later repeated settings win. */
  options(): ReadonlyMap<string, string> {
    const result = new Map<string, string>();
    for (const row of this.document.rows('OPTIONS')) {
      if (row.fields.length >= 2) result.set(row.fields[0]!.toUpperCase(), row.fields.slice(1).join(' '));
    }
    return result;
  }

  *nodes(): IterableIterator<SwmmNode> {
    const coords = new Map<string, readonly [number, number]>();
    for (const row of this.document.rows('COORDINATES')) {
      if (!row.fields[0]) continue;
      coords.set(row.fields[0], [numeric(row.fields[1], 'COORDINATES', row.line, 'x'), numeric(row.fields[2], 'COORDINATES', row.line, 'y')]);
    }
    for (const [section, kind] of [
      ['JUNCTIONS', 'junction'], ['OUTFALLS', 'outfall'], ['STORAGE', 'storage'], ['DIVIDERS', 'divider']
    ] as const) {
      for (const row of this.document.rows(section)) {
        const id = row.fields[0];
        if (id === undefined) continue;
        const xy = coords.get(id);
        yield {
          id, kind, invertElevation: numeric(row.fields[1], section, row.line, 'invertElevation'),
          line: row.line, ...(xy === undefined ? {} : { x: xy[0], y: xy[1] })
        };
      }
    }
  }

  *links(): IterableIterator<SwmmLink> {
    for (const [section, kind] of [
      ['CONDUITS', 'conduit'], ['PUMPS', 'pump'], ['ORIFICES', 'orifice'], ['WEIRS', 'weir'], ['OUTLETS', 'outlet']
    ] as const) {
      for (const row of this.document.rows(section)) {
        const [id, from, to] = row.fields;
        if (id === undefined || from === undefined || to === undefined) {
          throw new SyntaxError(`Missing link endpoint at ${section}:${row.line}`);
        }
        yield {
          id, kind, from, to, line: row.line,
          ...(kind === 'conduit' ? {
            length: numeric(row.fields[3], section, row.line, 'length'),
            roughness: numeric(row.fields[4], section, row.line, 'roughness')
          } : {})
        };
      }
    }
  }

  *subcatchments(): IterableIterator<SwmmSubcatchment> {
    for (const row of this.document.rows('SUBCATCHMENTS')) {
      const [id, rainGage, outlet] = row.fields;
      if (!id || !rainGage || !outlet) throw new SyntaxError(`Invalid SUBCATCHMENTS record at line ${row.line}`);
      yield {
        id, rainGage, outlet, area: numeric(row.fields[3], 'SUBCATCHMENTS', row.line, 'area'),
        imperviousPercent: numeric(row.fields[4], 'SUBCATCHMENTS', row.line, 'imperviousPercent'), line: row.line
      };
    }
  }

  /** Network indexes; unresolved endpoints are reported instead of silently ignored. */
  topology(): SwmmTopology {
    const nodes = new Map<string, SwmmNode>();
    const links = new Map<string, SwmmLink>();
    const incoming = new Map<string, string[]>();
    const outgoing = new Map<string, string[]>();
    const dangling = new Set<string>();
    for (const node of this.nodes()) {
      if (nodes.has(node.id)) throw new Error(`Duplicate node ID ${node.id}`);
      nodes.set(node.id, node);
      incoming.set(node.id, []); outgoing.set(node.id, []);
    }
    for (const link of this.links()) {
      if (links.has(link.id)) throw new Error(`Duplicate link ID ${link.id}`);
      links.set(link.id, link);
      if (nodes.has(link.from)) outgoing.get(link.from)!.push(link.id); else dangling.add(link.from);
      if (nodes.has(link.to)) incoming.get(link.to)!.push(link.id); else dangling.add(link.to);
    }
    return { nodes, links, incoming, outgoing, dangling: [...dangling] };
  }
}
