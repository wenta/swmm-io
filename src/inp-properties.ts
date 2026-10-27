import { InpDocument, type InpRow } from './inp.js';
import { inpFieldIndex, inpSchema, type FieldDescriptor, type SectionSchema } from './inp-schema.js';
import { InpColumnStore, type ColumnCacheOptions, type ColumnCacheStats, type MaterializationResult } from './inp-column-store.js';

export type InpValue = number | string;
/** A stable, ID-aligned result. Each value row follows the supplied field order. */
export interface InpBatchResult {
  readonly ids: readonly string[];
  readonly fields: readonly string[];
  readonly rows: readonly (readonly (InpValue | undefined)[])[];
}

/** Numeric batch columns; absent IDs, missing tokens and '*' use NaN. */
export interface InpNumericBatch {
  readonly ids: readonly string[];
  readonly fields: readonly string[];
  readonly columns: readonly Float64Array[];
}

export interface InpNumericColumn {
  readonly ids: readonly string[];
  /** Missing values are represented by NaN, never silently coerced to zero. */
  readonly values: Float64Array;
}

/** On-demand named property views. Unmodified INP text and unrecognized columns are retained. */
export class InpProperties {
  private readonly columns: InpColumnStore;
  constructor(private readonly document: InpDocument, cacheOptions: ColumnCacheOptions = {}) {
    this.columns = new InpColumnStore(document, cacheOptions);
  }

  /**
   * Materialize selected fixed-layout numeric fields, in one scan, with a
   * strict memory budget and all-or-nothing semantics. Never called on open.
   */
  materialize(section: string, fields: readonly string[]): MaterializationResult {
    return this.columns.materialize(section, fields);
  }

  /** Evict a section/field selection or all cached numeric data. Bytes freed. */
  evict(section?: string, fields?: readonly string[]): number {
    return this.columns.evict(section, fields);
  }

  /** Cache occupancy, counters and actual column sizes; takes no model scan. */
  cacheStats(): ColumnCacheStats { return this.columns.stats(); }

  /** Copies a cached column; undefined if that column has not been materialized. */
  cachedColumn(section: string, field: string): Float64Array | undefined {
    return this.columns.copyColumn(section, field);
  }

  /**
   * Zero-copy escape hatch. Mutating the returned array corrupts cached
   * results; use cachedColumn() if the caller may write to the array.
   */
  borrowColumn(section: string, field: string): Float64Array | undefined {
    return this.columns.borrowColumn(section, field);
  }

  /** Full schema or undefined for an unknown/free-form section. */
  schema(section: string): SectionSchema | undefined { return inpSchema(section); }

  /** A direct, lossless raw positional lookup, including unregistered sections. */
  raw(section: string, id: string, index: number): string | undefined {
    if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Field index must be nonnegative');
    return this.document.rowById(section,id)?.fields[index];
  }

  /** All raw rows for a key (e.g. curve/time-series points). */
  *rows(section: string, id: string): IterableIterator<InpRow> { yield* this.document.rowsById(section,id); }

  /**
   * Typed named field. Missing field or missing ID -> undefined. For named
   * numeric fields malformed literals raise SyntaxError (never become 0/NaN).
   * No default values or unit conversions are silently applied.
   */
  get(section: string, id: string, field: string): InpValue | undefined {
    const schema = inpSchema(section);
    if (!schema) throw new RangeError(`No registered schema for [${section.toUpperCase()}]`);
    // A cached finite value is served by one ID-map lookup and one typed-array
    // access, bypassing tokenization/object creation entirely. NaN is an
    // internal marker for either missing token or literal '*'; those cases
    // retain the original API behavior through a raw-row fallback.
    const cached = this.columns.find(section, id, field);
    if (cached !== undefined) return cached;
    const row = this.document.rowById(section,id);
    if (!row) return undefined;
    const fields = effectiveFields(schema,row,this.document);
    const index = fields.findIndex(x => x.name === field);
    if (index < 0) throw new RangeError(`Unknown ${section.toUpperCase()} field '${field}' for this record variant`);
    const raw = row.fields[index];
    if (raw === undefined) return undefined;
    const value = convert(raw,fields[index]!,section,id);
    // Auto mode only tracks valid numeric reads. It never promotes variable
    // positional layouts, quoted strings, '*' or absent fields.
    if (typeof value === 'number') this.columns.observe(section, field);
    return value;
  }

  /**
   * Retrieve a rectangular slice of named properties in caller-specified order.
   *
   * Unlike looping get(), every row is tokenized at most once; the section's
   * on-demand ID index is reused. Cached numeric columns bypass tokenization
   * entirely when the requested cell is finite. Unknown IDs produce undefined
   * cells. Unknown fields or invalid numeric literals throw as get() does.
   *
   * Complexity: O(ids * fields) after indexing, plus O(ids * tokensPerRow) for
   * rows requiring uncached values. The result is intentionally row-oriented.
   * Prefer numericMany() when requesting thousands of numerical attributes.
   */
  getMany(section: string, ids: readonly string[], fields: readonly string[]): InpBatchResult {
    const schema = inpSchema(section);
    if (!schema) throw new RangeError(`No registered schema for [${section.toUpperCase()}]`);
    const cached = fields.map(field => this.columns.borrowColumn(section, field));
    const positions = schema.variableLayout ? undefined : fields.map(field => {
      const i = schema.fields.findIndex(item => item.name === field);
      if (i < 0) throw new RangeError(`Unknown ${section.toUpperCase()} field '${field}'`);
      return i;
    });
    const rows: (InpValue | undefined)[][] = new Array(ids.length);
    for (let r = 0; r < ids.length; r++) {
      const id = ids[r]!;
      const physicalIndex = this.document.rowPosition(section, id);
      const values: (InpValue | undefined)[] = new Array(fields.length).fill(undefined);
      if (physicalIndex === undefined) { rows[r] = values; continue; }
      let row: InpRow | undefined;
      let variant: readonly FieldDescriptor[] | undefined;
      for (let c = 0; c < fields.length; c++) {
        const fast = cached[c]?.[physicalIndex];
        if (fast !== undefined && Number.isFinite(fast)) {
          values[c] = fast;
          continue;
        }
        row ??= this.document.rowById(section, id);
        if (!row) throw new Error(`Missing indexed record '${id}'`);
        variant ??= positions ? schema.fields : effectiveFields(schema, row, this.document);
        const position = positions ? positions[c]! : variant.findIndex(f => f.name === fields[c]);
        if (position < 0) throw new RangeError(`Unknown ${section.toUpperCase()} field '${fields[c]}' for this record variant`);
        const raw = row.fields[position];
        if (raw !== undefined) values[c] = convert(raw, variant[position]!, section, id);
      }
      rows[r] = values;
    }
    return { ids: [...ids], fields: [...fields], rows };
  }

  /**
   * Numeric columns aligned to supplied IDs; O(ids * fields) output, no
   * per-cell objects. Any missing/unspecified value becomes NaN, just like
   * numericColumn(). Unknown fields and text fields are rejected upfront.
   *
   * This method never materializes a persistent cache implicitly; when a
   * compatible column is already cached, values are copied from it directly.
   */
  numericMany(section: string, ids: readonly string[], fields: readonly string[]): InpNumericBatch {
    const schema = inpSchema(section);
    if (!schema) throw new RangeError(`No registered schema for [${section.toUpperCase()}]`);
    if (schema.variableLayout) throw new RangeError(`Numeric batch requires a fixed-layout section [${section.toUpperCase()}]`);
    const descriptors = fields.map(field => {
      const i = schema.fields.findIndex(item => item.name === field);
      if (i < 0) throw new RangeError(`Unknown ${section.toUpperCase()} field '${field}'`);
      const descriptor = schema.fields[i]!;
      if (descriptor.type === 'text') throw new TypeError(`'${field}' is not numeric`);
      return { index: i, descriptor, cached: this.columns.borrowColumn(section, field) };
    });
    const columns = fields.map(() => new Float64Array(ids.length).fill(NaN));
    for (let r = 0; r < ids.length; r++) {
      const id = ids[r]!;
      const physicalIndex = this.document.rowPosition(section, id);
      if (physicalIndex === undefined) continue;
      let row: InpRow | undefined;
      for (let c = 0; c < fields.length; c++) {
        const field = descriptors[c]!;
        const cached = field.cached?.[physicalIndex];
        if (cached !== undefined) { columns[c]![r] = cached; continue; }
        row ??= this.document.rowById(section, id);
        const raw = row?.fields[field.index];
        if (raw !== undefined && raw !== '*') columns[c]![r] = numberValue(raw, field.descriptor, section, id);
      }
    }
    return { ids: [...ids], fields: [...fields], columns };
  }

  /** Materialize exactly one record; does not materialize the entire section. */
  record(section: string, id: string): Readonly<Record<string, InpValue>> | undefined {
    const schema = inpSchema(section);
    if (!schema) throw new RangeError(`No registered schema for [${section.toUpperCase()}]`);
    const row = this.document.rowById(section,id);
    if (!row) return undefined;
    return fromRow(row,schema,this.document);
  }

  /** Iterator, so large sections need not be materialized as arrays. */
  *records(section: string): IterableIterator<Readonly<Record<string, InpValue>>> {
    const schema = inpSchema(section);
    if (!schema) throw new RangeError(`No registered schema for [${section.toUpperCase()}]`);
    for (const row of this.document.rows(section)) yield fromRow(row,schema,this.document);
  }

  /**
   * LID_CONTROLS is a multi-record format; one control can have distinct
   * SURFACE/SOIL/PAVEMENT/STORAGE/DRAIN/DRAINMAT layers. This fetches exactly
   * one requested layer without treating its TYPE row as its parameters.
   */
  layer(controlId: string, layer: string): Readonly<Record<string, InpValue>> | undefined {
    for (const row of this.document.rowsById('LID_CONTROLS',controlId)) {
      if (row.fields[1]?.toUpperCase() === layer.toUpperCase()) {
        return fromRow(row,inpSchema('LID_CONTROLS')!,this.document);
      }
    }
    return undefined;
  }

  /**
   * One-pass numeric extraction, returned as tightly packed Float64Array.
   * Skips no records. Missing fields get NaN and are identifiable via ids.
   * This avoids an object allocation per field or record during a bulk query.
   */
  numericColumn(section: string, field: string): InpNumericColumn {
    const schema = inpSchema(section);
    if (!schema) throw new RangeError(`No registered schema for [${section.toUpperCase()}]`);
    const idx = inpFieldIndex(section,field);
    const descriptor = schema.fields[idx]!;
    if (descriptor.type === 'text') throw new TypeError(`'${field}' is not a numeric field`);
    const cached = this.columns.copyColumn(section, field);
    if (cached) {
      // Deliberately copy payload so existing callers can freely mutate
      // numericColumn().values without poisoning the cache.
      return { ids: [...this.document.ids(section)], values: cached };
    }
    const ids: string[] = [];
    let values = new Float64Array(1024), length=0;
    this.document.forEachField(section,idx,(id,raw) => {
      if (length === values.length) {
        const grow = new Float64Array(values.length * 2);
        grow.set(values); values = grow;
      }
      ids.push(id);
      values[length++] = raw === undefined || raw === '*' ? NaN : numberValue(raw,descriptor,section,id);
    });
    return {ids,values:values.slice(0,length)};
  }
}

function numberValue(raw: string, field: FieldDescriptor, section: string, id: string): number {
  // Explicitly reject empty strings, Infinity and mixed tokens like '5abc'.
  if (raw.trim() === '' || !Number.isFinite(Number(raw))) {
    throw new SyntaxError(`Invalid ${section}.${field.name} for '${id}': '${raw}'`);
  }
  const value = Number(raw);
  if (field.type === 'integer' && !Number.isSafeInteger(value)) {
    throw new SyntaxError(`Expected integer ${section}.${field.name} for '${id}': '${raw}'`);
  }
  return value;
}
function convert(raw: string, field: FieldDescriptor, section: string, id: string): InpValue {
  // SWMM accepts '*' as an unspecified numeric value in several layouts;
  // preserve the sentinel rather than converting it to NaN or throwing.
  return field.type === 'text' || raw === '*' ? raw : numberValue(raw,field,section,id);
}
function fromRow(row: InpRow, schema: SectionSchema, document: InpDocument): Readonly<Record<string, InpValue>> {
  const result: Record<string, InpValue> = {};
  const fields = effectiveFields(schema,row,document);
  for (let i=0; i<Math.min(fields.length,row.fields.length);i++) {
    result[fields[i]!.name] = convert(row.fields[i]!, fields[i]!,row.section,row.fields[0]!);
  }
  // Unknown trailing fields are preserved under positional names so parsing
  // never discards information on new SWMM dialects.
  for (let i=fields.length;i<row.fields.length;i++) result[`field${i}`] = row.fields[i]!;
  return result;
}

// Variants are resolved per-record. Other section types use the position schema
// directly. Each call allocates only a handful of descriptors for that record.
const txt=(name:string):FieldDescriptor=>({name,type:'text'});
const num=(name:string):FieldDescriptor=>({name,type:'number'});
function effectiveFields(schema:SectionSchema,row:InpRow,document:InpDocument): readonly FieldDescriptor[] {
  const section=schema.section;
  if (section==='OUTFALLS') {
    const fixed=[txt('id'),num('invertElevation'),txt('outfallType')];
    if (row.fields[2]?.toUpperCase()==='FREE'||row.fields[2]?.toUpperCase()==='NORMAL') return [...fixed,txt('gated'),txt('routeTo')];
    return [...fixed,txt('stageData'),txt('gated'),txt('routeTo')];
  }
  if (section==='STORAGE') {
    const base=[txt('id'),num('invertElevation'),num('maxDepth'),num('initialDepth'),txt('shape')];
    const shape=row.fields[4]?.toUpperCase();
    if (shape==='TABULAR') return [...base,txt('areaCurve'),num('surchargeDepth'),num('evaporationFraction'),num('suctionHead'),num('conductivity'),num('initialDeficit')];
    if (shape==='FUNCTIONAL') return [...base,num('areaCoefficient'),num('areaExponent'),num('constantArea'),num('surchargeDepth'),num('evaporationFraction'),num('suctionHead'),num('conductivity'),num('initialDeficit')];
    if (['CYLINDRICAL','CONICAL','PARABOLOID','PYRAMIDAL'].includes(shape??'')) return [...base,num('length'),num('width'),num('sideSlope'),num('surchargeDepth'),num('evaporationFraction'),num('suctionHead'),num('conductivity'),num('initialDeficit')];
  }
  if (section==='XSECTIONS') {
    const base=[txt('id'),txt('shape')];
    const shape=row.fields[1]?.toUpperCase();
    if (shape==='IRREGULAR') return [...base,txt('transect')];
    if (shape==='STREET') return [...base,txt('street')];
    if (shape==='CUSTOM') return [...base,num('fullHeight'),txt('shapeCurve'),num('barrels')];
    return [...base,num('geometry1'),num('geometry2'),num('geometry3'),num('geometry4'),{name:'barrels',type:'integer'},txt('culvertCode')];
    // Standard geometric dimensions are numeric, but their physical meaning
    // (height, width, slopes, roughness) varies with cross-section shape.
  }
  if (section==='LID_CONTROLS') {
    const base=[txt('id'),txt('layer')];
    const layer=row.fields[1]?.toUpperCase();
    const fields:Readonly<Record<string,readonly FieldDescriptor[]>> = {
      SURFACE:[num('storageHeight'),num('vegetationFraction'),num('roughness'),num('slope'),num('sideSlope')],
      SOIL:[num('thickness'),num('porosity'),num('fieldCapacity'),num('wiltingPoint'),num('conductivity'),num('conductivitySlope'),num('suctionHead')],
      PAVEMENT:[num('thickness'),num('voidRatio'),num('imperviousFraction'),num('permeability'),num('cloggingFactor'),num('regenInterval'),num('regenFraction')],
      STORAGE:[num('thickness'),num('voidRatio'),num('seepageRate'),num('cloggingFactor')],
      DRAIN:[num('coefficient'),num('exponent'),num('offsetHeight'),num('delay'),txt('curve')],
      DRAINMAT:[num('thickness'),num('voidFraction'),num('roughness')]
    };
    if (layer&&fields[layer])return [...base,...fields[layer]];
  }
  if (section==='INFILTRATION') {
    const methods=['HORTON','MODIFIED_HORTON','GREEN_AMPT','MODIFIED_GREEN_AMPT','CURVE_NUMBER'];
    const option=document.rowById('OPTIONS','INFILTRATION')?.fields[1]?.toUpperCase();
    const last=row.fields[row.fields.length-1]?.toUpperCase();
    const method=methods.includes(last??'')?last:option;
    if (method==='HORTON'||method==='MODIFIED_HORTON') return [txt('id'),num('maxRate'),num('minRate'),num('decay'),num('dryingTime'),num('maxVolume'),txt('method')];
    if (method==='GREEN_AMPT'||method==='MODIFIED_GREEN_AMPT') return [txt('id'),num('suctionHead'),num('hydraulicConductivity'),num('initialDeficit'),txt('method')];
    if (method==='CURVE_NUMBER') return [txt('id'),num('curveNumber'),num('unused'),num('dryingTime'),txt('method')];
  }
  return schema.fields;
}
