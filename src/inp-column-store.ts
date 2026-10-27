import { InpDocument } from './inp.js';
import { inpSchema, type FieldDescriptor } from './inp-schema.js';

/**
 * `lazy` is the default: no cached numeric columns are created implicitly.
 * `auto` promotes frequently requested fixed-layout numeric fields on demand.
 */
export type ColumnCacheMode = 'lazy' | 'auto';

/**
 * Configuration for the INP numeric column cache.
 *
 * All limits count only the owned Float64Array payloads, not the original
 * text, section/ID index, or transient allocations. The cache deliberately
 * retains no duplicate ID map. Options are validated before use.
 */
export interface ColumnCacheOptions {
  readonly mode?: ColumnCacheMode;
  /** Maximum owned numeric payload size in bytes. Default: 64 MiB. */
  readonly maxBytes?: number;
  /** Minimum cold reads of a field before automatic promotion. Default: 256. */
  readonly minPromotionReads?: number;
  /** Reads per record required for promotion. Default: 0.15. */
  readonly promotionRatio?: number;
}

/** Snapshot of cache state; all counters are cumulative except bytes/columns. */
export interface ColumnCacheStats {
  readonly mode: ColumnCacheMode;
  readonly usedBytes: number;
  readonly maxBytes: number;
  readonly columns: number;
  readonly cached: ReadonlyArray<{ section: string; field: string; rows: number; bytes: number }>;
  readonly hits: number;
  readonly misses: number;
  readonly builds: number;
  readonly autoPromotions: number;
  readonly evictions: number;
}

/** Result of a manual materialize() call, including already-cached fields. */
export interface MaterializationResult {
  readonly section: string;
  readonly rows: number;
  readonly cachedFields: readonly string[];
  readonly newFields: readonly string[];
  readonly addedBytes: number;
  readonly totalCachedBytes: number;
}

const DEFAULT_BYTES = 64 * 1024 * 1024;
interface StoredColumn {
  readonly section: string;
  readonly field: string;
  readonly values: Float64Array;
}

/**
 * Fixed-layout numeric columns only. This is an internal cache rather than a
 * second parsed model. Row position and ID lookup are owned by InpDocument.
 *
 * Invariants:
 * 1. `values[i]` is the numeric value for physical record `i` in section order.
 * 2. A missing token or `*` is NaN; named get() falls back to the raw parser
 *    for NaN, so missing and `*` preserve their distinct public semantics.
 * 3. A failed/over-budget build commits NOTHING (no partially cached fields).
 * 4. Source documents are immutable. Edits return new InpDocument/InpModel
 *    instances, so caches can never silently become stale.
 */
export class InpColumnStore {
  readonly mode: ColumnCacheMode;
  readonly maxBytes: number;
  private readonly minPromotionReads: number;
  private readonly promotionRatio: number;
  private readonly columns = new Map<string, Map<string, StoredColumn>>();
  private readonly coldReads = new Map<string, number>();
  private used = 0;
  private hits = 0;
  private misses = 0;
  private builds = 0;
  private promotions = 0;
  private evictions = 0;

  constructor(private readonly document: InpDocument, opts: ColumnCacheOptions = {}) {
    this.mode = opts.mode ?? 'lazy';
    this.maxBytes = opts.maxBytes ?? DEFAULT_BYTES;
    this.minPromotionReads = opts.minPromotionReads ?? 256;
    this.promotionRatio = opts.promotionRatio ?? 0.15;
    if (this.mode !== 'lazy' && this.mode !== 'auto') throw new RangeError(`Unknown cache mode '${this.mode}'`);
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 0) throw new RangeError('maxBytes must be a nonnegative safe integer');
    if (!Number.isSafeInteger(this.minPromotionReads) || this.minPromotionReads < 1) throw new RangeError('minPromotionReads must be a positive safe integer');
    if (!Number.isFinite(this.promotionRatio) || this.promotionRatio <= 0) throw new RangeError('promotionRatio must be positive and finite');
  }

  /** Cached finite number or undefined (cache miss, missing token or `*`). */
  find(section: string, id: string, field: string): number | undefined {
    const column = this.columns.get(section.toUpperCase())?.get(field);
    if (!column) { this.misses++; return undefined; }
    const index = this.document.rowPosition(section, id);
    if (index === undefined) { this.misses++; return undefined; }
    const value = column.values[index];
    if (value === undefined || Number.isNaN(value)) { this.misses++; return undefined; }
    this.hits++;
    return value;
  }

  /**
   * Observe one cold named-property lookup. Only eligible fixed-layout numeric
   * fields can trigger promotion. A denied promotion (e.g. memory budget) is
   * suppressed until an eviction frees space, avoiding repeated full scans.
   */
  observe(section: string, field: string): void {
    if (this.mode !== 'auto') return;
    const name = section.toUpperCase();
    if (this.columns.get(name)?.has(field)) return;
    const schema = inpSchema(name);
    if (!schema || schema.variableLayout) return;
    const descriptor = schema.fields.find(d => d.name === field);
    if (!descriptor || descriptor.type === 'text') return;
    const key = JSON.stringify([name, field]);
    const attempts = (this.coldReads.get(key) ?? 0) + 1;
    this.coldReads.set(key, attempts);
    const rows = this.document.sectionRowCount(name);
    if (!rows) return;
    const threshold = Math.max(this.minPromotionReads, Math.ceil(rows * this.promotionRatio));
    if (attempts !== threshold) return;
    if (rows * Float64Array.BYTES_PER_ELEMENT > this.maxBytes - this.used) return;
    try {
      this.materialize(name, [field]);
      this.promotions++;
    } catch (error) {
      // Automatic caching is purely an optimization. A malformed value in
      // an *unrelated* row may make full-column parsing impossible, but must
      // never turn a previously valid single-field lookup into a failure.
      // Manual materialize() intentionally remains strict/transactional.
      if (!(error instanceof SyntaxError)) throw error;
    }
  }

  /**
   * Materialize requested numeric columns in ONE source scan. Uses the same
   * field positions as the fixed-layout schema, including quoted IDs, CRLF,
   * comments and repeated section headers. Existing columns are reused.
   *
   * A variable-layout section is intentionally rejected: the meaning of a
   * numeric position may vary by record (e.g. STORAGE, INFILTRATION).
   * Use InpProperties.get/record for typed variants or raw() for all fields.
   *
   * @throws RangeError for unknown/text/variant fields or insufficient budget.
   * @throws SyntaxError for an invalid numeric token, with full rollback.
   */
  materialize(section: string, fields: readonly string[]): MaterializationResult {
    const name = section.toUpperCase();
    const schema = inpSchema(name);
    if (!schema) throw new RangeError(`No registered schema for [${name}]`);
    if (schema.variableLayout) throw new RangeError(`Cannot materialize variant section [${name}] safely`);
    const requested = [...new Set(fields)];
    const stored = this.columns.get(name);
    const fresh: { name: string; index: number; descriptor: FieldDescriptor }[] = [];
    for (const field of requested) {
      const index = schema.fields.findIndex(d => d.name === field);
      if (index < 0) throw new RangeError(`Unknown ${name} field '${field}'`);
      const descriptor = schema.fields[index]!;
      if (descriptor.type === 'text') throw new TypeError(`'${field}' is not a numeric field`);
      if (!stored?.has(field)) fresh.push({ name: field, index, descriptor });
    }
    const rows = this.document.sectionRowCount(name);
    const extra = rows * Float64Array.BYTES_PER_ELEMENT * fresh.length;
    if (extra > this.maxBytes - this.used) {
      throw new RangeError(`Column cache budget exceeded: need ${extra} more bytes, available ${this.maxBytes - this.used}`);
    }
    // Build off-cache: allocation/parse failures leave previous state intact.
    const pending = fresh.map(f => ({ ...f, values: new Float64Array(rows) }));
    if (pending.length) {
      this.document.forEachSelectedFields(name, pending.map(x => x.index), (rowIndex, id, values) => {
        for (let j = 0; j < pending.length; j++) {
          const item = pending[j]!;
          const raw = values[j];
          item.values[rowIndex] = raw === undefined || raw === '*' ? NaN
            : parseNumeric(raw, item.descriptor, name, id);
        }
      });
      let byField = stored;
      if (!byField) { byField = new Map(); this.columns.set(name, byField); }
      for (const item of pending) byField.set(item.name, { section: name, field: item.name, values: item.values });
      this.used += extra;
      this.builds++;
    }
    return {
      section: name, rows, cachedFields: requested, newFields: fresh.map(x => x.name),
      addedBytes: extra, totalCachedBytes: this.used
    };
  }

  /** Returns a defensive copy of a materialized column, or undefined. */
  copyColumn(section: string, field: string): Float64Array | undefined {
    return this.columns.get(section.toUpperCase())?.get(field)?.values.slice();
  }

  /**
   * Zero-copy view for advanced callers. DO NOT mutate it: doing so corrupts
   * subsequent property reads! Eviction does not invalidate a borrowed view,
   * but it no longer reflects the live cache. Use copyColumn() for isolation.
   */
  borrowColumn(section: string, field: string): Float64Array | undefined {
    return this.columns.get(section.toUpperCase())?.get(field)?.values;
  }

  /** Evict one field, an entire section, or all cached columns. Returns bytes freed. */
  evict(section?: string, fields?: readonly string[]): number {
    if (section === undefined && fields !== undefined) throw new TypeError('fields require a section');
    let freed = 0;
    const remove = (name: string, byField: Map<string, StoredColumn>, selected?: readonly string[]) => {
      for (const field of selected ?? [...byField.keys()]) {
        const old = byField.get(field);
        if (old) { freed += old.values.byteLength; byField.delete(field); this.evictions++; }
      }
      if (!byField.size) this.columns.delete(name);
    };
    if (section === undefined) {
      for (const [name, columns] of this.columns) remove(name, columns);
    } else {
      const name = section.toUpperCase();
      const byField = this.columns.get(name);
      if (byField) remove(name, byField, fields);
    }
    this.used -= freed;
    // After eviction, automatic promotion becomes possible again.
    if (freed) this.coldReads.clear();
    return freed;
  }

  stats(): ColumnCacheStats {
    const cached: ColumnCacheStats['cached'][number][] = [];
    for (const [section, fields] of this.columns)
      for (const [field, item] of fields)
        cached.push({ section, field, rows: item.values.length, bytes: item.values.byteLength });
    return {
      mode: this.mode, usedBytes: this.used, maxBytes: this.maxBytes,
      columns: cached.length, cached, hits: this.hits, misses: this.misses,
      builds: this.builds, autoPromotions: this.promotions, evictions: this.evictions
    };
  }
}

function parseNumeric(raw: string, field: FieldDescriptor, section: string, id: string): number {
  if (!raw.trim() || !Number.isFinite(Number(raw)))
    throw new SyntaxError(`Invalid ${section}.${field.name} for '${id}': '${raw}'`);
  const num = Number(raw);
  if (field.type === 'integer' && !Number.isSafeInteger(num))
    throw new SyntaxError(`Expected integer ${section}.${field.name} for '${id}': '${raw}'`);
  return num;
}
