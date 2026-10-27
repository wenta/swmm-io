import { type ByteSource, MemorySource, throwIfAborted } from './source.js';

export type ResultKind = 'subcatch' | 'node' | 'link' | 'system';
export type ElementKind = Exclude<ResultKind, 'system'> | 'pollutant';
export interface SeriesRequest { readonly kind: ResultKind; readonly object: number | string; readonly attribute: string | number; }
export interface OutOpenOptions { readonly encoding?: string; readonly allowSimulationErrors?: boolean; }
export type ReadStrategy = 'auto' | 'sparse' | 'bulk';

/** Physical reading strategy for the multi-channel query engine. */
export type QueryStrategy = 'auto' | 'sparse' | 'grouped' | 'sequential';
/**
 * A declarative, zero-HTTP query. Specify either `requests` (mixed kinds and
 * arbitrary channels) or the `kind`/`objects`/`attributes` product.
 * `periods.to` is exclusive. No model data is copied while planning.
 */
export interface OutQuerySpec {
  readonly requests?: readonly SeriesRequest[];
  readonly kind?: ResultKind;
  readonly objects?: readonly (number | string)[];
  readonly attributes?: readonly (string | number)[];
  readonly periods?: { readonly from: number; readonly to: number };
  readonly strategy?: QueryStrategy;
  readonly format?: 'columnar';
  /** Alias for maxOutputBytes when used with query(). */
  readonly maxMemoryBytes?: number;
  /** Maximum allowed bulk-read amplification relative to grouped reads (default 64). */
  readonly maxReadAmplification?: number;
}
/**
 * One contiguous series-major Float32Array. Column `s` occupies
 * `values.subarray(s * periodCount, (s + 1) * periodCount)`; no object per cell.
 */
export interface OutQueryChunk {
  readonly from: number;
  readonly to: number;
  readonly requests: readonly SeriesRequest[];
  readonly values: Float32Array;
  readonly seriesCount: number;
  readonly periodCount: number;
  readonly layout: 'series-major';
  /** Zero-copy column view. The returned view shares the chunk's buffer. */
  column(index: number): Float32Array;
}
export interface OutQueryStreamOptions extends OutReadOptions {
  /** Target reporting periods per chunk; default 2048, reduced by maxOutputBytes. */
  readonly chunkPeriods?: number;
}
export interface OutQueryPlan {
  readonly strategy: Exclude<QueryStrategy, 'auto'> | 'memory';
  readonly periodCount: number;
  readonly seriesCount: number;
  readonly distinctColumns: number;
  readonly groups: number;
  readonly estimatedReadBytes: number;
  readonly estimatedReadCalls: number;
  readonly outputBytes: number;
}
export interface OutAggregateResult {
  readonly requests: readonly SeriesRequest[];
  readonly totalPeriods: number;
  readonly min: Float64Array;
  readonly max: Float64Array;
  readonly mean: Float64Array;
  readonly finiteCount: Uint32Array;
  readonly nonFiniteCount: Uint32Array;
}
interface PreparedQuery {
  readonly requests: readonly SeriesRequest[];
  readonly from: number;
  readonly to: number;
  readonly offsets: readonly number[];
  readonly sortedUnique: readonly number[];
}
interface PhysicalGroup {
  readonly start: number;
  readonly end: number;
  readonly positions: readonly { readonly offset: number; readonly targets: readonly number[] }[];
}

/** Query-level resource limits and cooperative cancellation. */
export interface OutReadOptions {
  readonly signal?: AbortSignal;
  /** Maximum size of the returned numeric arrays; default 256 MiB. */
  readonly maxOutputBytes?: number;
  /** Maximum transient source read buffer; default 2 MiB. */
  readonly maxReadBytes?: number;
  /** Maximum concurrent source reads; default 16 (range 1–32). */
  readonly maxConcurrency?: number;
}
/** Results aligned to requested object identifiers; duplicates are preserved. */
export interface SelectedSnapshot {
  readonly objects: readonly (number | string)[];
  readonly values: Float32Array;
}

export type PropertyKind = 'subcatch' | 'node' | 'link';
export interface OutProperties {
  /** Property codes in the physical column order of the .out file. */
  readonly codes: readonly number[];
  /** Row-major: objectIndex * codes.length + propertyIndex. Type codes (0) are INT4. */
  readonly values: Float32Array;
  /** Extract a single value, decoding integer type codes correctly. */
  get(objectIndex: number, propertyCode: number, occurrence?: number): number;
  /** Names correspond to columns in codes/values, including duplicated codes. */
  readonly names: readonly string[];
  /** O(1) named lookup after one-time property index build. */
  getNamed(objectIndex: number, name: string): number;
}
/** Metadata names for static fields actually stored in .out (NOT every .inp field). */
const STATIC_NAMES: Readonly<Record<PropertyKind, Readonly<Record<number, string>>>> = {
  subcatch: {1:'area'},
  node: {0:'type',2:'invertElevation',3:'maxDepth'},
  link: {0:'type',3:'maxDepth',4:'offset',5:'length'}
};

export interface SeriesChunk {
  readonly start: number;
  readonly end: number;
  readonly values: Float32Array;
}
export interface SeriesEnvelope {
  /** Reporting period indexes (0-based, strictly increasing). */
  readonly periods: Uint32Array;
  /** Values for the corresponding reporting periods. */
  readonly values: Float32Array;
}
export interface SeriesStatistics {
  readonly totalPeriods: number;
  readonly finiteCount: number;
  readonly nonFiniteCount: number;
  readonly min: number;
  readonly max: number;
  readonly mean: number;
}


const MAGIC = 516114522;
const NAMES: Record<ResultKind, Readonly<Record<string, number>>> = {
  subcatch: { rainfall: 0, snowDepth: 1, evaporation: 2, infiltration: 3, runoff: 4, groundwaterFlow: 5, groundwaterElevation: 6, soilMoisture: 7 },
  node: { depth: 0, head: 1, volume: 2, lateralInflow: 3, totalInflow: 4, flooding: 5 },
  link: { flow: 0, depth: 1, velocity: 2, volume: 3, capacity: 4 },
  system: { airTemperature: 0, rainfall: 1, snowDepth: 2, losses: 3, runoff: 4, dryWeatherInflow: 5, groundwaterInflow: 6, rdiiInflow: 7, directInflow: 8, lateralInflow: 9, flooding: 10, outflow: 11, storage: 12, actualEvaporation: 13, potentialEvaporation: 14 }
};

export interface OutInfo {
  readonly version: number;
  readonly flowUnits: number;
  readonly nSubcatch: number;
  readonly nNodes: number;
  readonly nLinks: number;
  readonly nPollutants: number;
  readonly periods: number;
  readonly reportStepSeconds: number;
  readonly startDateSerial: number;
  readonly errorCode: number;
  readonly bytesPerPeriod: number;
}

function dv(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function int(view: DataView, pos: number): number { return view.getInt32(pos, true); }
function validateCount(value: number, name: string): number {
  if (value < 0 || value > 200_000_000) throw new Error(`Invalid SWMM ${name}: ${value}`);
  return value;
}

/** An EPA SWMM 5.x .out reader. Lazy values: no complete file decode. */
export class OutReader {
  private readonly idCache = new Map<ElementKind, readonly string[]>();
  private loadingIds?: Promise<void>;
  private pollutantUnitsCache: readonly number[] = [];
  private readonly nameIndexes = new Map<ResultKind, ReadonlyMap<string, number>>();
  private readonly propertyCache = new Map<PropertyKind, OutProperties>();
  private readonly propertyLoading = new Map<PropertyKind, Promise<OutProperties>>();
  private constructor(
    private readonly source: ByteSource,
    readonly info: OutInfo,
    private readonly positions: { id: number; props: number; results: number },
    private readonly variableCodes: Readonly<Record<ResultKind, readonly number[]>>,
    private readonly options: OutOpenOptions
  ) {}

  static async open(source: ByteSource, options: OutOpenOptions = {}): Promise<OutReader> {
    if (!Number.isSafeInteger(source.size) || source.size < 0) throw new RangeError('Invalid byte source size');
    if (source.size < 52) throw new Error('File is too small to be a SWMM .out');
    const [head, tail] = await Promise.all([source.read(0, 28), source.read(source.size - 24, 24)]);
    const h = dv(head), t = dv(tail);
    if (int(h, 0) !== MAGIC || int(t, 20) !== MAGIC) throw new Error('Invalid SWMM .out magic');
    const [id, props, results, periods, errorCode] = [int(t, 0), int(t, 4), int(t, 8), int(t, 12), int(t, 16)];
    const [nSubcatch, nNodes, nLinks, nPollutants] = [int(h, 12), int(h, 16), int(h, 20), int(h, 24)];
    validateCount(nSubcatch, 'subcatchment count'); validateCount(nNodes, 'node count');
    validateCount(nLinks, 'link count'); validateCount(nPollutants, 'pollutant count');
    validateCount(periods, 'reporting period count');
    if (![0,1,2,3,4,5,6,7,8,9].includes(int(h, 8))) {
      throw new Error('Invalid flow unit identifier');
    }
    if (errorCode !== 0 && !options.allowSimulationErrors) throw new Error(`SWMM simulation failed with error code ${errorCode}`);
    if (!(id >= 28 && props > id && results > props + 12 && results <= source.size - 24)) {
      throw new Error('Invalid SWMM .out section offsets');
    }

    // Skip model input properties dynamically; output variables follow them.
    let cursor = props;
    for (const count of [nSubcatch, nNodes, nLinks]) {
      const bytes = await source.read(cursor, 4);
      const properties = validateCount(int(dv(bytes), 0), 'property count');
      if (properties > 1000) throw new Error('Invalid number of model properties');
      cursor += 4 + properties * 4 + count * properties * 4;
      if (cursor >= results) throw new Error('Model properties extend beyond results');
    }
    const variableCodes = {} as Record<ResultKind, number[]>;
    for (const kind of ['subcatch', 'node', 'link', 'system'] as const) {
      const bytes = await source.read(cursor, 4);
      const count = validateCount(int(dv(bytes), 0), 'variable count');
      if (count > 5000 || cursor + 4 + count * 4 > results) throw new Error('Invalid variable metadata');
      cursor += 4;
      const codes = dv(await source.read(cursor, count * 4));
      const list: number[] = [];
      for (let i = 0; i < count; i++) list.push(int(codes, i * 4));
      variableCodes[kind] = list;
      cursor += count * 4;
    }
    if (results - 12 !== cursor) throw new Error('Invalid reporting interval section');
    const interval = dv(await source.read(results - 12, 12));
    const startDateSerial = interval.getFloat64(0, true);
    const reportStepSeconds = int(interval, 8);
    const bytesPerPeriod = 8 + 4 * (nSubcatch * variableCodes.subcatch.length + nNodes * variableCodes.node.length + nLinks * variableCodes.link.length + variableCodes.system.length);
    if (!Number.isSafeInteger(bytesPerPeriod) || bytesPerPeriod <= 0 || reportStepSeconds <= 0) throw new Error('Invalid report record layout');
    const resultEnd = results + periods * bytesPerPeriod;
    if (!Number.isSafeInteger(resultEnd) || resultEnd > source.size - 24) throw new Error('Truncated SWMM .out time series');
    return new OutReader(source, {
      version: int(h, 4), flowUnits: int(h, 8), nSubcatch, nNodes, nLinks, nPollutants,
      periods, reportStepSeconds, startDateSerial, errorCode, bytesPerPeriod
    }, { id, props, results }, variableCodes, options);
  }

  /**
   * Read per-object static property metadata from the .out file, without reading simulation results.
   * Property 0 (node/link type) is saved by EPA as INT4, not REAL4.
   */
  async properties(kind: PropertyKind): Promise<OutProperties> {
    const cached = this.propertyCache.get(kind);
    if (cached) return cached;
    const loading = this.propertyLoading.get(kind);
    if (loading) return loading;
    // Single-flight deduplicates expensive static property decoding across
    // concurrent callers, exactly as ids() does for element-name sections.
    const promise = this.loadProperties(kind);
    this.propertyLoading.set(kind, promise);
    try { return await promise; }
    finally { this.propertyLoading.delete(kind); }
  }

  private async loadProperties(kind: PropertyKind): Promise<OutProperties> {
    let at = this.positions.props;
    for (const type of ['subcatch', 'node', 'link'] as const) {
      const columns = int(dv(await this.source.read(at, 4)), 0);
      if (columns < 0 || columns > 1000) throw new Error('Invalid property count');
      const codesView = dv(await this.source.read(at + 4, 4 * columns));
      const codes = Array.from({ length: columns }, (_, i) => int(codesView, 4 * i));
      const length = this.objectCount(type) * columns;
      const valuesView = dv(await this.source.read(at + 4 + columns * 4, length * 4));
      if (type === kind) {
        const values = new Float32Array(length);
        for (let i = 0; i < length; i++) {
          // Node/link type is an INT4 stored in the same 4-byte property slot.
          values[i] = codes[i % columns] === 0 ? valuesView.getInt32(i * 4, true) : valuesView.getFloat32(i * 4, true);
        }
        // Build indexes exactly once; don't linear-scan the property code list
        // on every get() when querying large networks. Duplicate codes such as
        // upstream/downstream offsets get distinct stable names.
        const byCode = new Map<number, number[]>();
        const byName = new Map<string, number>();
        const names: string[] = [];
        for (let i = 0; i < columns; i++) {
          const code = codes[i]!;
          const previous = byCode.get(code);
          if (previous) previous.push(i); else byCode.set(code,[i]);
          const occurrence = (previous?.length ?? 1) - 1;
          const key = type === 'link' && code === 4
            ? (occurrence === 0 ? 'inletOffset' : occurrence === 1 ? 'outletOffset' : `offset${occurrence}`)
            : (STATIC_NAMES[type][code] ?? `code${code}`);
          // Some SWMM extensions can repeat arbitrary unknown codes; preserve
          // all columns rather than dropping earlier duplicates.
          const name = byName.has(key) ? `${key}_${occurrence}` : key;
          byName.set(name,i);
          names.push(name);
        }
        const checkObject = (objectIndex: number): void => {
          if (!Number.isInteger(objectIndex) || objectIndex < 0 || objectIndex >= (columns ? length / columns : 0)) {
            throw new RangeError(`Unknown object index ${objectIndex}`);
          }
        };
        const props: OutProperties = {
          codes, names, values,
          get(objectIndex: number, code: number, occurrence = 0) {
            checkObject(objectIndex);
            if (!Number.isInteger(occurrence) || occurrence < 0) throw new RangeError('Invalid property occurrence');
            const column = byCode.get(code)?.[occurrence];
            if (column === undefined) throw new RangeError(`Unknown property code ${code}, occurrence ${occurrence}`);
            return values[objectIndex * columns + column]!;
          },
          getNamed(objectIndex: number, name: string) {
            checkObject(objectIndex);
            const column = byName.get(name);
            if (column === undefined) throw new RangeError(`Unknown property name ${name}`);
            return values[objectIndex * columns + column]!;
          }
        };
        this.propertyCache.set(kind, props);
        return props;
      }
      at += 4 + 4 * columns + 4 * length;
    }
    throw new RangeError(`Unknown property kind ${kind}`);
  }

  /** Read one named static property using a SWMM element identifier. */
  async propertyValue(kind: PropertyKind, object: number | string, name: string): Promise<number> {
    const [properties, index] = await Promise.all([this.properties(kind), this.objectIndex(kind,object)]);
    return properties.getNamed(index,name);
  }

  /**
   * Describes every result variable present, including pollutant columns.
   * Unknown future code values are retained rather than discarded.
   */
  async columnNames(kind: ResultKind): Promise<readonly {code:number; name:string}[]> {
    const standard = NAMES[kind];
    const reverse = new Map<number,string>();
    for (const [name,code] of Object.entries(standard)) reverse.set(code,name);
    const base = kind === 'subcatch' ? 8 : kind === 'node' ? 6 : kind === 'link' ? 5 : 15;
    const pollutants = kind === 'system' ? [] : await this.ids('pollutant');
    return this.variableCodes[kind].map(code => ({
      code, name: reverse.get(code) ?? (code >= base && code < base + pollutants.length
        ? `pollutant:${pollutants[code - base]}` : `code${code}`)
    }));
  }

  /** IDs include pollutant identifiers; caller controls legacy character encoding. */
  async ids(kind: ElementKind): Promise<readonly string[]> {
    const cached = this.idCache.get(kind);
    if (cached !== undefined) return cached;
    // Single-flight: thousands of simultaneous ID lookups must NOT read and
    // decode the complete names section thousands of times (large city models).
    if (!this.loadingIds) {
      this.loadingIds = this.loadIds().catch(error => {
        this.loadingIds = undefined; // retry after transient read failure
        throw error;
      });
    }
    await this.loadingIds;
    return this.idCache.get(kind)!;
  }

  private async loadIds(): Promise<void> {
    const bytes = await this.source.read(this.positions.id, this.positions.props - this.positions.id);
    const view = dv(bytes);
    const ids = new Map<ElementKind, string[]>([
      ['subcatch', []], ['node', []], ['link', []], ['pollutant', []]
    ]);
    let cursor = 0;
    const decoder = new TextDecoder(this.options.encoding ?? 'utf-8', { fatal: true });
    for (const [type, count] of [
      ['subcatch', this.info.nSubcatch], ['node', this.info.nNodes],
      ['link', this.info.nLinks], ['pollutant', this.info.nPollutants]
    ] as const) {
      for (let i = 0; i < count; i++) {
        if (cursor + 4 > bytes.length) throw new Error('Truncated ID record');
        const len = int(view, cursor);
        cursor += 4;
        if (len < 0 || len > 1_000_000 || cursor + len > bytes.length) throw new Error('Invalid ID length');
        ids.get(type)!.push(decoder.decode(bytes.subarray(cursor, cursor + len)));
        cursor += len;
      }
    }
    const units: number[] = [];
    for (let i = 0; i < this.info.nPollutants; i++) {
      if (cursor + 4 > bytes.length) throw new Error('Truncated pollutant units');
      units.push(int(view, cursor));
      cursor += 4;
    }
    if (cursor !== bytes.length) throw new Error('Unexpected bytes in ID section');
    this.pollutantUnitsCache = units;
    for (const type of ['subcatch', 'node', 'link', 'pollutant'] as const) {
      const values = ids.get(type)!;
      this.idCache.set(type, values);
      if (type !== 'pollutant') {
        if (new Set(values).size !== values.length) throw new Error(`Duplicate ${type} IDs`);
        this.nameIndexes.set(type, new Map(values.map((name, idx) => [name, idx])));
      }
    }
  }

  async pollutantUnits(): Promise<readonly number[]> {
    await this.ids('pollutant');
    return this.pollutantUnitsCache;
  }

  /** Pollutant columns start after the standard SWMM variables (8, 6 and 5). */
  async pollutantSeries(kind: Exclude<ResultKind, 'system'>, object: number | string, pollutant: number | string,
    start = 0, end = this.info.periods): Promise<Float32Array> {
    const pollutants = await this.ids('pollutant');
    const idx = typeof pollutant === 'number' ? pollutant : pollutants.indexOf(pollutant);
    if (!Number.isInteger(idx) || idx < 0 || idx >= pollutants.length) throw new RangeError(`Unknown pollutant ${pollutant}`);
    const code = (kind === 'subcatch' ? 8 : kind === 'node' ? 6 : 5) + idx;
    return this.series(kind, object, code, start, end);
  }

  /** Available SWMM variable codes in the order physically stored in .out. */
  columns(kind: ResultKind): readonly number[] { return this.variableCodes[kind]; }

  /** Date/time of a reporting period, as SWMM serial days since 1899-12-30. */
  async timestampSerial(period: number): Promise<number> {
    this.checkPeriod(period);
    const offset = this.positions.results + period * this.info.bytesPerPeriod;
    return dv(await this.source.read(offset, 8)).getFloat64(0, true);
  }

  /** UTC Date for a SWMM serial timestamp (no local timezone interpretation). */
  async timestamp(period: number): Promise<Date> {
    const serial = await this.timestampSerial(period);
    return new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86_400_000));
  }

  /** Read one scalar without materializing a full series. */
  async value(kind: ResultKind, object: number | string, attribute: string | number, period: number): Promise<number> {
    this.checkPeriod(period);
    const objectId = await this.objectIndex(kind, object);
    const at = this.positions.results + period * this.info.bytesPerPeriod + this.valueOffset(kind, objectId, attribute);
    if (this.source instanceof MemorySource) return this.source.view.getFloat32(at, true);
    return dv(await this.source.read(at, 4)).getFloat32(0, true);
  }

  /** All output columns for one object at a chosen timestep (EPA get*Result equivalent). */
  async objectResult(kind: ResultKind, object: number | string, period: number): Promise<Float32Array> {
    this.checkPeriod(period);
    const objectId = await this.objectIndex(kind, object);
    const n = this.variableCodes[kind].length;
    const at = this.positions.results + period * this.info.bytesPerPeriod + this.kindStart(kind) + objectId * n * 4;
    const source = this.source instanceof MemorySource
      ? this.source.view
      : dv(await this.source.read(at, n * 4));
    const result = new Float32Array(n);
    const base = this.source instanceof MemorySource ? at : 0;
    for (let i = 0; i < n; i++) result[i] = source.getFloat32(base + i * 4, true);
    return result;
  }

  /** All report timestamps, in SWMM serial days, with contiguous/chunked I/O. */
  async timestampsSerial(start = 0, end = this.info.periods): Promise<Float64Array> {
    this.checkRange(start, end);
    const count = end - start;
    const timestamps = new Float64Array(count);
    if (count === 0) return timestamps;
    const stride = this.info.bytesPerPeriod;
    const base = this.positions.results + start * stride;
    if (this.source instanceof MemorySource) {
      for (let i = 0; i < count; i++) timestamps[i] = this.source.view.getFloat64(base + i * stride, true);
      return timestamps;
    }
    // For a huge per-period record avoid reading every object's results just
    // to obtain one 8-byte timestamp.
    if (stride > 128 * 1024) {
      for (let i = 0; i < count; i += 16) {
        const n = Math.min(16, count - i);
        await Promise.all(Array.from({length:n}, async (_, j) => {
          timestamps[i + j] = dv(await this.source.read(base + (i + j) * stride, 8)).getFloat64(0, true);
        }));
      }
      return timestamps;
    }
    const chunkSize = Math.max(1, Math.floor((2 * 1024 * 1024 - 8) / stride) + 1);
    for (let i = 0; i < count; i += chunkSize) {
      const n = Math.min(chunkSize, count - i);
      const view = dv(await this.source.read(base + i * stride, (n - 1) * stride + 8));
      for (let j = 0; j < n; j++) timestamps[i + j] = view.getFloat64(j * stride, true);
    }
    return timestamps;
  }

  /**
   * Read the selected objects at one reporting period without decoding all
   * other elements or loading the whole per-period record. Coalesces nearby
   * physical offsets, preserves request order (including duplicates), and
   * bounds parallel I/O. Ideal for zoom-dependent city-map views.
   */
  async snapshotSelected(kind: ResultKind, attribute: string | number, period: number,
    objects: readonly (number | string)[], options: OutReadOptions = {}): Promise<SelectedSnapshot> {
    this.checkPeriod(period);
    const budget = this.queryLimits(options);
    if (objects.length * 4 > budget.maxOutputBytes) throw new RangeError('snapshotSelected output exceeds maxOutputBytes');
    throwIfAborted(options.signal);
    const values = new Float32Array(objects.length);
    if (!objects.length) return { objects: [...objects], values };
    const column = this.columnIndex(kind, attribute);
    const base = this.positions.results + period * this.info.bytesPerPeriod;
    const columns = this.variableCodes[kind].length;
    const start = this.kindStart(kind);
    // Resolve the ID table once, then perform synchronous numeric lookups.
    // Avoid one microtask/Promise per element in 100k–300k-element city views.
    if (kind !== 'system' && objects.some(x => typeof x === 'string')) await this.ids(kind);
    const physical = objects.map((object, i) => ({
      index: i, offset: start + this.objectIndexSync(kind, object) * columns * 4 + column * 4
    }));
    throwIfAborted(options.signal);
    if (this.source instanceof MemorySource) {
      for (const item of physical) values[item.index] = this.source.view.getFloat32(base + item.offset, true);
      return { objects: [...objects], values };
    }
    // Group small nearby regions. Capping each group avoids pathological
    // over-read when two requested IDs are far apart in a million-link model.
    physical.sort((a, b) => a.offset - b.offset);
    const groups: { start: number; last: number; items: typeof physical }[] = [];
    for (const entry of physical) {
      let group = groups[groups.length - 1];
      if (!group || entry.offset - group.last > 256 || entry.offset - group.start + 4 > budget.maxReadBytes) {
        group = { start: entry.offset, last: entry.offset, items: [] };
        groups.push(group);
      }
      group.last = entry.offset;
      group.items.push(entry);
    }
    for (let i = 0; i < groups.length; i += budget.maxConcurrency) {
      throwIfAborted(options.signal);
      await Promise.all(groups.slice(i, i + budget.maxConcurrency).map(async group => {
        const buffer = dv(await this.source.read(base + group.start, group.last - group.start + 4, options));
        throwIfAborted(options.signal);
        for (const entry of group.items) values[entry.index] = buffer.getFloat32(entry.offset - group.start, true);
      }));
    }
    return { objects: [...objects], values };
  }

  private queryLimits(options: OutReadOptions): { maxReadBytes: number; maxOutputBytes: number; maxConcurrency: number } {
    const maxReadBytes = options.maxReadBytes ?? 2 * 1024 * 1024;
    const maxOutputBytes = options.maxOutputBytes ?? 256 * 1024 * 1024;
    const maxConcurrency = options.maxConcurrency ?? 16;
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes < 4 || maxReadBytes > 256 * 1024 * 1024)
      throw new RangeError('maxReadBytes must be within [4, 256 MiB]');
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0)
      throw new RangeError('maxOutputBytes must be nonnegative');
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1 || maxConcurrency > 32)
      throw new RangeError('maxConcurrency must be within [1, 32]');
    return { maxReadBytes, maxOutputBytes, maxConcurrency };
  }

  /** Fast path for one variable: uses the batched multi-series implementation. */
  async series(kind: ResultKind, object: number | string, attribute: string | number,
    start = 0, end = this.info.periods, strategy: ReadStrategy = 'auto', options: OutReadOptions = {}): Promise<Float32Array> {
    const arrays = await this.seriesMany([{ kind, object, attribute }], start, end, strategy, options);
    return arrays[0]!;
  }

  /**
   * Extract multiple independent columns with shared read windows. Results follow
   * request order. Only the required result bytes are decoded to Float32 arrays.
   * For file-backed sources, 'auto' chooses between sequential bulk reading
   * and bounded-concurrency sparse reading based on over-read amplification.
   */
  async seriesMany(requests: readonly SeriesRequest[], start = 0, end = this.info.periods,
    strategy: ReadStrategy = 'auto', options: OutReadOptions = {}): Promise<readonly Float32Array[]> {
    this.checkRange(start, end);
    const limits = this.queryLimits(options);
    throwIfAborted(options.signal);
    if (requests.length * (end - start) * 4 > limits.maxOutputBytes) throw new RangeError('Series output exceeds maxOutputBytes');
    if (requests.length === 0) return [];
    // Thousands of separate Float32Array instances incur substantial JS heap
    // overhead beyond their 4-byte payload; use snapshotSelected for large
    // object sets at one timestamp instead of abusing seriesMany.
    if (requests.length > 32768) throw new RangeError('Too many series; use snapshots or batched queries');
    const kindsWithNames = new Set(requests.filter(r => r.kind !== 'system' && typeof r.object === 'string').map(r => r.kind));
    await Promise.all([...kindsWithNames].map(kind => this.ids(kind as ElementKind)));
    const offsets = requests.map(r => this.valueOffset(r.kind, this.objectIndexSync(r.kind, r.object), r.attribute));
    const count = end - start;
    const output = offsets.map(() => new Float32Array(count));
    if (count === 0) return output;
    const stride = this.info.bytesPerPeriod;
    const periodBase = this.positions.results + start * stride;
    if (this.source instanceof MemorySource) {
      const view = this.source.view;
      for (let p = 0; p < count; p++) {
        if ((p & 4095) === 0) throwIfAborted(options.signal);
        const base = periodBase + p * stride;
        for (let c = 0; c < offsets.length; c++) output[c]![p] = view.getFloat32(base + offsets[c]!, true);
      }
      return output;
    }
    let minOffset = offsets[0]!;
    let maxOffset = offsets[0]!;
    for (let i = 1; i < offsets.length; i++) {
      if (offsets[i]! < minOffset) minOffset = offsets[i]!;
      if (offsets[i]! > maxOffset) maxOffset = offsets[i]!;
    }
    const width = maxOffset - minOffset + 4;
    // Trade off read amplification against I/O call overhead.
    // Single-column long runs with large records must NOT automatically read
    // hundreds of MB merely because each per-period record is under 64 KiB.
    const estimatedBulkBytes = (count - 1) * stride + width;
    const estimatedUsefulBytes = count * offsets.length * 4;
    const mode = strategy === 'auto'
      ? (estimatedBulkBytes <= limits.maxReadBytes ||
         // For dense, compact period records, a few sequential reads can be
         // vastly cheaper than tens of thousands of sparse syscalls, even if
         // they transfer 20–50x the useful bytes.
         (stride <= 1024 && estimatedBulkBytes <= 64 * 1024 * 1024) ||
         (estimatedBulkBytes <= 32 * 1024 * 1024 && estimatedBulkBytes <= estimatedUsefulBytes * 32)
           ? 'bulk' : 'sparse')
      : strategy;
    if (mode === 'bulk') {
      // The chunk is capped at approximately 2 MiB even on large files.
      if (width > limits.maxReadBytes) throw new RangeError('Bulk span exceeds maxReadBytes; use sparse or increase limit');
      const chunkPeriods = Math.max(1, Math.floor((limits.maxReadBytes - width) / stride) + 1);
      for (let p = 0; p < count; p += chunkPeriods) {
        throwIfAborted(options.signal);
        const n = Math.min(chunkPeriods, count - p);
        const chunk = dv(await this.source.read(periodBase + p * stride + minOffset, (n - 1) * stride + width, options));
        for (let j = 0; j < n; j++) {
          const base = j * stride - minOffset;
          for (let c = 0; c < offsets.length; c++) {
            output[c]![p + j] = chunk.getFloat32(base + offsets[c]!, true);
          }
        }
      }
      return output;
    }
    // Sparse reads avoid gigabytes of over-reading. Coalesce nearby columns,
    // bounded by maxReadBytes; maxConcurrency controls in-flight reads.
    const sorted = offsets.map((offset, col) => ({ offset, col })).sort((a, b) => a.offset - b.offset);
    const groups: { at: number; last: number; columns: { offset: number; col: number }[] }[] = [];
    for (const col of sorted) {
      let group = groups[groups.length - 1];
      if (!group || col.offset - group.last > 256 || col.offset - group.at + 4 > limits.maxReadBytes) {
        group = { at: col.offset, last: col.offset, columns: [] };
        groups.push(group);
      }
      group.last = col.offset;
      group.columns.push(col);
    }
    // O(groups) scratch space even for millions of reporting periods.
    // Each batch uses at most 16 I/O calls in flight.
    for (const group of groups) {
      for (let i = 0; i < count; i += limits.maxConcurrency) {
        throwIfAborted(options.signal);
        const batch = Math.min(limits.maxConcurrency, count - i);
        await Promise.all(Array.from({ length: batch }, async (_, j) => {
          const period = i + j;
          const bytes = dv(await this.source.read(periodBase + period * stride + group.at, group.last - group.at + 4, options));
          throwIfAborted(options.signal);
          for (const col of group.columns) output[col.col]![period] = bytes.getFloat32(col.offset - group.at, true);
        }));
      }
    }
    return output;
  }


  /**
   * Plan an arbitrary multi-channel query without fetching result values.
   * The cost model charges 16 KiB per source.read() as an I/O overhead proxy.
   * Estimates are explanatory, not promised byte counts or latency guarantees.
   */
  async explainQuery(spec: OutQuerySpec, options: OutReadOptions = {}): Promise<OutQueryPlan> {
    const query = await this.prepareQuery(spec, options);
    const limits = this.queryLimits(options);
    return this.planQuery(query, spec.strategy ?? 'auto', limits.maxReadBytes, spec.maxReadAmplification ?? 64);
  }

  /**
   * Execute one bounded, bulk query into a single series-major Float32Array.
   * The caller owns the result, which is independent from transient I/O buffers.
   * Use queryStream for results larger than maxMemoryBytes/maxOutputBytes.
   */
  async query(spec: OutQuerySpec, options: OutReadOptions = {}): Promise<OutQueryChunk> {
    const query = await this.prepareQuery(spec, options);
    const maxBytes = Math.min(spec.maxMemoryBytes ?? Infinity, options.maxOutputBytes ?? Infinity, 256 * 1024 * 1024);
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('Invalid maxMemoryBytes');
    const size = query.requests.length * (query.to - query.from) * 4;
    if (!Number.isSafeInteger(size) || size > maxBytes) throw new RangeError('query output exceeds memory budget; use queryStream');
    return this.executeQuery(query, spec.strategy ?? 'auto', { ...options, maxOutputBytes: maxBytes }, spec.maxReadAmplification ?? 64);
  }

  /**
   * Incremental multi-channel query with backpressure and bounded buffers.
   * An AsyncGenerator yields after every chunk, so callers can process long
   * simulations without materializing all periods. ID lookup occurs once.
   */
  async *queryStream(spec: OutQuerySpec, options: OutQueryStreamOptions = {}): AsyncGenerator<OutQueryChunk> {
    const q = await this.prepareQuery(spec, options);
    const budget = this.queryLimits({ ...options, maxOutputBytes: Math.min(spec.maxMemoryBytes ?? Infinity, options.maxOutputBytes ?? Infinity, 256 * 1024 * 1024) });
    const requestedChunk = options.chunkPeriods ?? 2048;
    if (!Number.isSafeInteger(requestedChunk) || requestedChunk < 1) throw new RangeError('Invalid chunkPeriods');
    const rowBytes = q.requests.length * 4;
    if (rowBytes > budget.maxOutputBytes) throw new RangeError('One period exceeds memory budget');
    const byBudget = rowBytes ? Math.floor(budget.maxOutputBytes / rowBytes) : requestedChunk;
    const chunkPeriods = Math.max(1, Math.min(requestedChunk, byBudget));
    for (let cursor = q.from; cursor < q.to; cursor += chunkPeriods) {
      throwIfAborted(options.signal);
      const part: PreparedQuery = { ...q, from: cursor, to: Math.min(cursor + chunkPeriods, q.to) };
      yield await this.executeQuery(part, spec.strategy ?? 'auto', options, spec.maxReadAmplification ?? 64);
    }
  }

  /**
   * One-pass per-channel min/max/mean statistics. Kahan summation minimizes
   * accumulated error. NaN and infinities count as non-finite, not zero.
   */
  async aggregateMany(spec: OutQuerySpec, options: OutQueryStreamOptions = {}): Promise<OutAggregateResult> {
    const q = await this.prepareQuery(spec, options);
    const n = q.requests.length;
    const min = new Float64Array(n).fill(Infinity);
    const max = new Float64Array(n).fill(-Infinity);
    const mean = new Float64Array(n);
    const finiteCount = new Uint32Array(n);
    const nonFiniteCount = new Uint32Array(n);
    const compensation = new Float64Array(n);
    for await (const chunk of this.queryStream(spec, options)) {
      for (let col = 0; col < n; col++) {
        const start = col * chunk.periodCount;
        for (let i = 0; i < chunk.periodCount; i++) {
          const value = chunk.values[start + i]!;
          if (!Number.isFinite(value)) { nonFiniteCount[col]!++; continue; }
          finiteCount[col]!++;
          if (value < min[col]!) min[col] = value;
          if (value > max[col]!) max[col] = value;
          const adjusted = value - compensation[col]!;
          const sum = mean[col]! + adjusted;
          compensation[col] = (sum - mean[col]!) - adjusted;
          mean[col] = sum;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (!finiteCount[i]) { min[i] = NaN; max[i] = NaN; mean[i] = NaN; }
      else mean[i] = mean[i]! / finiteCount[i]!;
    }
    return { requests: q.requests, totalPeriods: q.to - q.from, min, max, mean, finiteCount, nonFiniteCount };
  }

  private async prepareQuery(spec: OutQuerySpec, options: OutReadOptions): Promise<PreparedQuery> {
    throwIfAborted(options.signal);
    if (spec.maxReadAmplification !== undefined && (!Number.isFinite(spec.maxReadAmplification) || spec.maxReadAmplification < 1)) throw new RangeError('maxReadAmplification must be >= 1');
    if (spec.format !== undefined && spec.format !== 'columnar') throw new RangeError('Only columnar output is supported');
    const explicit = spec.requests !== undefined;
    if (explicit && (spec.kind !== undefined || spec.objects !== undefined || spec.attributes !== undefined)) {
      throw new TypeError('Use either requests or kind/objects/attributes');
    }
    if (!explicit && (spec.kind === undefined || spec.objects === undefined || spec.attributes === undefined)) {
      throw new TypeError('Missing kind, objects, or attributes');
    }
    const requests: readonly SeriesRequest[] = explicit
      ? [...spec.requests!]
      : spec.objects!.flatMap(object => spec.attributes!.map(attribute => ({ kind: spec.kind!, object, attribute })));
    if (requests.length > 1_000_000) throw new RangeError('Too many query channels');
    const from = spec.periods?.from ?? 0;
    const to = spec.periods?.to ?? this.info.periods;
    this.checkRange(from, to);
    const named = new Set(requests.filter(r => r.kind !== 'system' && typeof r.object === 'string').map(r => r.kind));
    await Promise.all([...named].map(kind => this.ids(kind as ElementKind)));
    throwIfAborted(options.signal);
    const offsets = requests.map(r => this.valueOffset(r.kind, this.objectIndexSync(r.kind, r.object), r.attribute));
    const sortedUnique = [...new Set(offsets)].sort((a,b) => a-b);
    return { requests, from, to, offsets, sortedUnique };
  }

  /** Offset clustering is shared by planner and executor to keep estimates honest. */
  private queryGroups(q: PreparedQuery, maxReadBytes: number, maxGap = 256): PhysicalGroup[] {
    const targets = new Map<number, number[]>();
    for (let i = 0; i < q.offsets.length; i++) {
      const offset = q.offsets[i]!;
      const list = targets.get(offset);
      if (list) list.push(i); else targets.set(offset, [i]);
    }
    const groups: {start:number;end:number;positions:{offset:number;targets:number[]}[]}[] = [];
    for (const offset of q.sortedUnique) {
      let group = groups[groups.length - 1];
      if (!group || offset - group.end > maxGap || offset + 4 - group.start > maxReadBytes) {
        group = { start: offset, end: offset + 4, positions: [] };
        groups.push(group);
      }
      group.end = offset + 4;
      group.positions.push({offset, targets: targets.get(offset)!});
    }
    return groups;
  }

  private planQuery(q: PreparedQuery, requested: QueryStrategy, maxReadBytes: number, maxAmplification: number): OutQueryPlan {
    if (!Number.isFinite(maxAmplification) || maxAmplification < 1) throw new RangeError('maxReadAmplification must be >= 1');
    const count = q.to - q.from;
    const cols = q.requests.length;
    if (this.source instanceof MemorySource) return {
      strategy:'memory', periodCount:count, seriesCount:cols, distinctColumns:q.sortedUnique.length,
      groups:0,estimatedReadBytes:0,estimatedReadCalls:0,outputBytes:count*cols*4
    };
    const groups = this.queryGroups(q, maxReadBytes);
    if (!count || !groups.length) return {
      strategy:'sparse', periodCount:count,seriesCount:cols,distinctColumns:q.sortedUnique.length,
      groups:groups.length,estimatedReadBytes:0,estimatedReadCalls:0,outputBytes:count*cols*4
    };
    const width = q.sortedUnique[q.sortedUnique.length - 1]! - q.sortedUnique[0]! + 4;
    const stride = this.info.bytesPerPeriod;
    const sparseBytes = q.sortedUnique.length * 4 * count;
    const sparseCalls = q.sortedUnique.length * count;
    const groupedBytes = groups.reduce((total, g) => total + g.end - g.start, 0) * count;
    const groupedCalls = groups.length * count;
    const bulkPossible = width <= maxReadBytes;
    const perChunk = bulkPossible ? Math.max(1, Math.floor((maxReadBytes - width) / stride) + 1) : 1;
    const bulkCalls = bulkPossible ? Math.ceil(count / perChunk) : Infinity;
    const bulkBytes = bulkPossible ? count * width + (count - bulkCalls) * (stride - width) : Infinity;
    // 16 KiB per I/O operation approximates syscall / promise overhead. It is
    // NOT measured latency, but prevents optimizing byte counts alone.
    const penalty = 16 * 1024;
    // Avoid unexpectedly reading a full city-sized output when the caller
    // requests a handful of widely scattered channels. Forcing 'sequential'
    // remains possible if the caller knows their storage has high seek costs.
    const sequentialAllowed = bulkBytes <= groupedBytes * maxAmplification;
    const costs = { sparse:sparseBytes + sparseCalls*penalty, grouped:groupedBytes + groupedCalls*penalty,
      sequential:sequentialAllowed ? bulkBytes + bulkCalls*penalty : Infinity };
    const method = requested === 'auto'
      ? (Object.keys(costs) as Exclude<QueryStrategy, 'auto'>[]).reduce((best,k) => costs[k] < costs[best] ? k : best,'sparse')
      : requested;
    if (method === 'sequential' && !bulkPossible) throw new RangeError('Sequential span exceeds maxReadBytes');
    const bytes = method === 'sparse' ? sparseBytes : method === 'grouped' ? groupedBytes : bulkBytes;
    const calls = method === 'sparse' ? sparseCalls : method === 'grouped' ? groupedCalls : bulkCalls;
    return {strategy:method,periodCount:count,seriesCount:cols,distinctColumns:q.sortedUnique.length,
      groups:groups.length,estimatedReadBytes:bytes,estimatedReadCalls:calls,outputBytes:count*cols*4};
  }

  private async executeQuery(q: PreparedQuery, strategy: QueryStrategy, options: OutReadOptions, maxAmplification: number): Promise<OutQueryChunk> {
    const limits = this.queryLimits(options);
    throwIfAborted(options.signal);
    const count = q.to - q.from;
    const channels = q.requests.length;
    const resultBytes = channels * count * 4;
    if (!Number.isSafeInteger(resultBytes) || resultBytes > limits.maxOutputBytes) {
      throw new RangeError('Query result exceeds maxOutputBytes');
    }
    const output = new Float32Array(channels * count);
    const chunk: OutQueryChunk = {
      from:q.from,to:q.to,requests:q.requests,values:output,seriesCount:channels,periodCount:count,
      layout:'series-major',column(index:number) {
        if (!Number.isSafeInteger(index) || index < 0 || index >= channels) throw new RangeError('Invalid column index');
        return output.subarray(index * count, (index+1)*count);
      }
    };
    if (!count || !channels) return chunk;
    const start = this.positions.results + q.from * this.info.bytesPerPeriod;
    const stride = this.info.bytesPerPeriod;
    // In-memory shortcut: no synthetic Promise or async byte-source allocations.
    if (this.source instanceof MemorySource) {
      const view = this.source.view;
      for (let p = 0; p < count; p++) {
        if ((p & 1023) === 0) throwIfAborted(options.signal);
        const base = start + p * stride;
        for (let c = 0; c < channels; c++) output[c*count+p] = view.getFloat32(base + q.offsets[c]!,true);
      }
      return chunk;
    }
    const plan = this.planQuery(q, strategy, limits.maxReadBytes, maxAmplification);
    if (plan.strategy === 'sequential') {
      const min = q.sortedUnique[0]!;
      const max = q.sortedUnique[q.sortedUnique.length-1]! + 4;
      const width = max-min;
      const periodChunk = Math.max(1, Math.floor((limits.maxReadBytes-width)/stride)+1);
      for (let p=0; p<count; p+=periodChunk) {
        throwIfAborted(options.signal);
        const n = Math.min(periodChunk,count-p);
        const data = dv(await this.source.read(start + p*stride + min, (n-1)*stride+width, options));
        throwIfAborted(options.signal);
        for (let j=0; j<n; j++) {
          const row = j*stride-min;
          for (let col=0; col<channels; col++) output[col*count+p+j] = data.getFloat32(row+q.offsets[col]!,true);
        }
      }
      return chunk;
    }
    const groups = plan.strategy === 'sparse'
      ? this.queryGroups(q, 4, 0) : this.queryGroups(q, limits.maxReadBytes);
    // Group or sparse: O(maxConcurrency) in-flight I/O promises, never O(periods).
    // Within each read, fill every requested column in that physical group.
    const batchSize = limits.maxConcurrency;
    for (const group of groups) {
      for (let p=0; p<count; p+=batchSize) {
        throwIfAborted(options.signal);
        const n = Math.min(batchSize,count-p);
        await Promise.all(Array.from({length:n},async(_,j) => {
          const period = p+j;
          const data = dv(await this.source.read(start + period*stride + group.start, group.end-group.start,options));
          throwIfAborted(options.signal);
          for (const item of group.positions) {
            const value = data.getFloat32(item.offset-group.start,true);
            for (const col of item.targets) output[col*count+period] = value;
          }
        }));
      }
    }
    return chunk;
  }

  /**
   * Bounded-memory streaming iterator, preserving the original reporting period indexes.
   * Callers can process arbitrarily long output files without allocating a full series.
   */
  async *seriesChunks(kind: ResultKind, object: number | string, attribute: string | number,
    start = 0, end = this.info.periods, chunkPeriods = 8192,
    strategy: ReadStrategy = 'auto', options: OutReadOptions = {}): AsyncGenerator<SeriesChunk> {
    this.checkRange(start, end);
    if (!Number.isSafeInteger(chunkPeriods) || chunkPeriods < 1 || chunkPeriods > 10_000_000) {
      throw new RangeError('chunkPeriods must be between 1 and 10000000');
    }
    for (let cursor = start; cursor < end; cursor += chunkPeriods) {
      const until = Math.min(end, cursor + chunkPeriods);
      throwIfAborted(options.signal);
      yield { start: cursor, end: until, values: await this.series(kind, object, attribute, cursor, until, strategy, options) };
    }
  }

  /** Streaming statistics; does not materialize the entire signal in memory. */
  async seriesStatistics(kind: ResultKind, object: number | string, attribute: string | number,
    start = 0, end = this.info.periods, chunkPeriods = 8192, options: OutReadOptions = {}): Promise<SeriesStatistics> {
    this.checkRange(start, end);
    let min = Infinity, max = -Infinity, sum = 0, compensation = 0, count = 0;
    for await (const { values } of this.seriesChunks(kind, object, attribute, start, end, chunkPeriods, 'auto', options)) {
      for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        if (!Number.isFinite(v)) continue;
        count++;
        if (v < min) min = v;
        if (v > max) max = v;
        const y = v - compensation;
        const next = sum + y;
        compensation = (next - sum) - y;
        sum = next;
      }
    }
    return {
      totalPeriods: end - start, finiteCount: count, nonFiniteCount: end - start - count,
      min: count ? min : NaN, max: count ? max : NaN, mean: count ? sum / count : NaN
    };
  }

  /**
   * Min/max envelope with first and last point preserved, suitable for drawing large
   * series without hiding spikes. Scans every source point, but uses O(maxPoints)
   * additional memory and produces at most maxPoints output points.
   * Non-finite values are omitted from interior buckets.
   */
  async seriesEnvelope(kind: ResultKind, object: number | string, attribute: string | number,
    start = 0, end = this.info.periods, maxPoints = 1000, chunkPeriods = 8192,
    options: OutReadOptions = {}): Promise<SeriesEnvelope> {
    this.checkRange(start, end);
    if (!Number.isInteger(maxPoints) || maxPoints < 4 || maxPoints > 20_000_000) {
      throw new RangeError('maxPoints must be an integer between 4 and 20000000');
    }
    const n = end - start;
    if (n === 0) return { periods: new Uint32Array(0), values: new Float32Array(0) };
    // Short series can be returned verbatim, including non-finite values.
    if (n <= maxPoints) {
      const values = await this.series(kind, object, attribute, start, end, 'auto', options);
      return { periods: Uint32Array.from({length: n}, (_, i) => start + i), values };
    }
    const bucketCount = Math.min(n - 2, Math.floor((maxPoints - 2) / 2));
    const minValues = new Float32Array(bucketCount).fill(Infinity);
    const maxValues = new Float32Array(bucketCount).fill(-Infinity);
    const minAt = new Uint32Array(bucketCount), maxAt = new Uint32Array(bucketCount);
    const seen = new Uint8Array(bucketCount);
    const accept = (p: number, value: number): void => {
      if (!Number.isFinite(value)) return;
      const bucket = Math.min(bucketCount - 1, Math.floor(((p - start - 1) * bucketCount) / (n - 2)));
      if (!seen[bucket] || value < minValues[bucket]!) { minValues[bucket] = value; minAt[bucket] = p; }
      if (!seen[bucket] || value > maxValues[bucket]!) { maxValues[bucket] = value; maxAt[bucket] = p; }
      seen[bucket] = 1;
    };
    if (this.source instanceof MemorySource) {
      // True one-pass zero-intermediate-array path for in-memory results.
      const objectIndex = await this.objectIndex(kind, object);
      const offset = this.positions.results + this.valueOffset(kind, objectIndex, attribute);
      const view = this.source.view;
      for (let p = start + 1; p < end - 1; p++) {
        if ((p & 4095) === 0) throwIfAborted(options.signal);
        accept(p, view.getFloat32(offset + p * this.info.bytesPerPeriod, true));
      }
    } else {
      for await (const { start: first, values } of this.seriesChunks(kind, object, attribute, start + 1, end - 1, chunkPeriods, 'auto', options)) {
        for (let j = 0; j < values.length; j++) accept(first + j, values[j]!);
      }
    }
    const x: number[] = [start];
    const y: number[] = [await this.value(kind, object, attribute, start)];
    for (let i = 0; i < bucketCount; i++) {
      if (!seen[i]) continue;
      const a = minAt[i]!, b = maxAt[i]!;
      if (a === b) { x.push(a); y.push(minValues[i]!); }
      else if (a < b) { x.push(a, b); y.push(minValues[i]!, maxValues[i]!); }
      else { x.push(b, a); y.push(maxValues[i]!, minValues[i]!); }
    }
    x.push(end - 1);
    y.push(await this.value(kind, object, attribute, end - 1));
    return { periods: Uint32Array.from(x), values: Float32Array.from(y) };
  }

  /** Single timestamp, chosen variable, all objects of selected kind. */
  async snapshot(kind: ResultKind, attribute: string | number, period: number,
    options: OutReadOptions = {}): Promise<Float32Array> {
    this.checkPeriod(period);
    const limits = this.queryLimits(options);
    throwIfAborted(options.signal);
    const count = this.objectCount(kind);
    const variables = this.variableCodes[kind].length;
    const idx = this.columnIndex(kind, attribute);
    const offset = this.kindStart(kind);
    if (count * 4 > limits.maxOutputBytes) throw new RangeError('Snapshot exceeds maxOutputBytes');
    if (variables * 4 > limits.maxReadBytes) throw new RangeError('One object exceeds maxReadBytes');
    const values = new Float32Array(count);
    const chunk = Math.max(1, Math.floor(limits.maxReadBytes / Math.max(4, variables * 4)));
    for (let i = 0; i < count; i += chunk) {
      throwIfAborted(options.signal);
      const n = Math.min(chunk, count - i);
      const position = this.positions.results + period * this.info.bytesPerPeriod + offset + i * variables * 4;
      const buf = dv(await this.source.read(position, n * variables * 4, options));
      for (let j = 0; j < n; j++) values[i + j] = buf.getFloat32((j * variables + idx) * 4, true);
    }
    return values;
  }

  async close(): Promise<void> { await this.source.close?.(); }

  private objectCount(kind: ResultKind): number {
    switch (kind) {
      case 'subcatch': return this.info.nSubcatch;
      case 'node': return this.info.nNodes;
      case 'link': return this.info.nLinks;
      case 'system': return 1;
    }
  }
  private kindStart(kind: ResultKind): number {
    const n = this.info;
    const vars = this.variableCodes;
    const subBytes = n.nSubcatch * vars.subcatch.length * 4;
    const nodeBytes = n.nNodes * vars.node.length * 4;
    const linkBytes = n.nLinks * vars.link.length * 4;
    switch (kind) {
      case 'subcatch': return 8;
      case 'node': return 8 + subBytes;
      case 'link': return 8 + subBytes + nodeBytes;
      case 'system': return 8 + subBytes + nodeBytes + linkBytes;
    }
  }
  private columnIndex(kind: ResultKind, attribute: string | number): number {
    const code = typeof attribute === 'string' ? NAMES[kind][attribute] : attribute;
    if (code === undefined) throw new RangeError(`Unknown ${kind} attribute: ${attribute}`);
    const pos = this.variableCodes[kind].indexOf(code);
    if (pos === -1) throw new RangeError(`SWMM .out does not contain ${kind} attribute code ${code}`);
    return pos;
  }
  private valueOffset(kind: ResultKind, object: number, attribute: string | number): number {
    return this.kindStart(kind) + (object * this.variableCodes[kind].length + this.columnIndex(kind, attribute)) * 4;
  }
  private async objectIndex(kind: ResultKind, object: number | string): Promise<number> {
    if (kind !== 'system' && typeof object === 'string') await this.ids(kind);
    return this.objectIndexSync(kind, object);
  }

  /** Requires ID metadata to be loaded when object is a string. */
  private objectIndexSync(kind: ResultKind, object: number | string): number {
    if (kind === 'system') {
      if (object !== 0 && object !== 'system') throw new RangeError('System index must be 0');
      return 0;
    }
    const index = typeof object === 'number' ? object : this.nameIndexes.get(kind)?.get(object);
    if (index === undefined || !Number.isSafeInteger(index) || index < 0 || index >= this.objectCount(kind)) {
      throw new RangeError(`Unknown ${kind} object: ${object}`);
    }
    return index;
  }
  private checkPeriod(period: number): void {
    if (!Number.isInteger(period) || period < 0 || period >= this.info.periods) throw new RangeError(`Invalid period ${period}`);
  }
  private checkRange(start: number, end: number): void {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end > this.info.periods || start > end) {
      throw new RangeError(`Invalid period range [${start}, ${end})`);
    }
  }
}
