import { OutReader, type OutReadOptions, type SeriesEnvelope, type SeriesRequest } from './out.js';
import { OutSeriesIndex } from './out-index.js';
import { throwIfAborted } from './source.js';

/**
 * Storage hooks are deliberately transport-neutral. A Node app may use files,
 * while a browser app may use IndexedDB or the Origin Private File System.
 * Implementations MUST scope the key to an immutable, verified source identity.
 */
export interface OutIndexStore {
  load(key: string): Promise<Uint8Array | undefined>;
  save?(key: string, sidecar: Uint8Array): Promise<void>;
}

/** Await one shared operation without letting this caller cancel another's work. */
function awaitCaller<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort);
      const error = new Error('SWMM index wait aborted');
      error.name = 'AbortError';
      reject(error);
    };
    signal.addEventListener('abort', onAbort, {once:true});
    void work.then(
      value => {signal.removeEventListener('abort',onAbort); resolve(value);},
      error => {signal.removeEventListener('abort',onAbort); reject(error);}
    );
  });
}

export interface OutIndexCacheOptions {
  /** Maximum resident bytes used by index trees, excluding JS wrapper overhead. */
  readonly maxBytes: number;
  /** Maximum resident indexes. Default: unlimited. */
  readonly maxEntries?: number;
  /** Optional sidecar persistence, outside the in-memory budget. */
  readonly store?: OutIndexStore;
}

export interface OutIndexCacheStats {
  readonly entries: number;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly builds: number;
  readonly restores: number;
  readonly evictions: number;
  readonly inflight: number;
}

/**
 * Low-overhead resident LRU with single-flight index creation.
 *
 * Complexity: O(1) lookup, insertion and LRU eviction via insertion-ordered Map.
 * Only explicitly requested channels are built. A channel too large for the
 * whole budget is rejected BEFORE reading a single result value.
 *
 * Never use an arbitrary filename as sourceKey: an unchanging key must denote
 * the same immutable bytes. Content hashing or a verified immutable object ID
 * is recommended; fast file metadata fingerprints are a trust trade-off.
 */
export class OutIndexCache {
  private readonly entries = new Map<string, OutSeriesIndex>();
  private readonly pending = new Map<string, Promise<OutSeriesIndex>>();
  private usedBytes = 0;
  private hits = 0;
  private misses = 0;
  private builds = 0;
  private restores = 0;
  private evictions = 0;
  private generation = 0;
  readonly maxBytes: number;
  readonly maxEntries: number;
  private readonly store?: OutIndexStore;

  constructor(options: OutIndexCacheOptions) {
    if (!Number.isSafeInteger(options?.maxBytes) || options.maxBytes < 0)
      throw new RangeError('Invalid index cache maxBytes');
    const maxEntries = options.maxEntries ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 0)
      throw new RangeError('Invalid index cache maxEntries');
    this.maxBytes = options.maxBytes;
    this.maxEntries = maxEntries;
    this.store = options.store;
  }

  /** The required resident bytes can be calculated from the .out header alone. */
  static requiredBytes(periods: number): number {
    if (!Number.isSafeInteger(periods) || periods < 1 || periods > 0xfffffffe)
      throw new RangeError('Invalid number of periods');
    let capacity = 1;
    while (capacity < periods) capacity *= 2;
    const bytes = capacity * 32;
    if (!Number.isSafeInteger(bytes)) throw new RangeError('Index too large');
    return bytes;
  }

  canFit(periods: number): boolean {
    return this.maxEntries > 0 && OutIndexCache.requiredBytes(periods) <= this.maxBytes;
  }

  /** Stable JSON tuple, so channel IDs containing separators never collide. */
  private key(out: OutReader, request: SeriesRequest, sourceKey: string): string {
    const i = out.info;
    return JSON.stringify([sourceKey, i.version, i.flowUnits, i.periods,
      i.reportStepSeconds, i.bytesPerPeriod, i.nSubcatch, i.nNodes,
      i.nLinks, i.nPollutants, i.startDateSerial, request.kind,
      request.object, request.attribute]);
  }

  get(out: OutReader, request: SeriesRequest, sourceKey: string): OutSeriesIndex | undefined {
    const key = this.key(out, request, sourceKey);
    const index = this.entries.get(key);
    if (!index) { this.misses++; return undefined; }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, index);
    return index;
  }

  /**
   * Coalesces concurrent builds for a given source/channel. If the optional
   * persistent store contains an invalid sidecar, validation fails closed;
   * callers can remove the sidecar and retry, not silently use stale results.
   *
   * The originating caller controls cancellation of the shared build. A later
   * caller may abort its own wait without canceling work initiated by another.
   * To isolate each build's lifetime completely, construct separate caches.
   */
  async getOrBuild(out: OutReader, request: SeriesRequest, sourceKey: string,
    options: { readonly readOptions?: OutReadOptions; readonly chunkPeriods?: number } = {}): Promise<OutSeriesIndex> {
    throwIfAborted(options.readOptions?.signal);
    const key = this.key(out, request, sourceKey);
    const cached = this.entries.get(key);
    if (cached) { this.hits++; this.entries.delete(key); this.entries.set(key, cached); return cached; }
    const pending = this.pending.get(key);
    if (pending) { this.hits++; return awaitCaller(pending,options.readOptions?.signal); }
    this.misses++;
    if (!this.canFit(out.info.periods)) throw new RangeError('Index exceeds cache maxBytes or maxEntries');
    const generation = this.generation;
    const execute = async (): Promise<OutSeriesIndex> => {
      let index: OutSeriesIndex;
      const sidecar = await this.store?.load(key);
      if (sidecar) {
        index = OutSeriesIndex.restore(out, sidecar, {sourceKey, expectedRequest: request, maxIndexBytes: this.maxBytes});
        this.restores++;
      } else {
        index = await OutSeriesIndex.build(out, request, {
          sourceKey, maxIndexBytes: this.maxBytes, chunkPeriods: options.chunkPeriods,
          readOptions: options.readOptions
        });
        this.builds++;
        if (this.store?.save) await this.store.save(key, index.serialize());
      }
      if (this.generation === generation) this.insert(key, index);
      return index;
    };
    const work = execute();
    this.pending.set(key, work);
    try { return await work; }
    finally { if (this.pending.get(key) === work) this.pending.delete(key); }
  }

  private insert(key: string, index: OutSeriesIndex): void {
    // An in-flight build can finish after an explicit clear/evict. The index
    // remains valid but the cache never exceeds its configured budget.
    const existing = this.entries.get(key);
    if (existing) { this.usedBytes -= existing.indexBytes; this.entries.delete(key); }
    while (this.entries.size >= this.maxEntries || this.usedBytes + index.indexBytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) throw new RangeError('Index exceeds cache budget');
      this.remove(oldest);
      this.evictions++;
    }
    this.entries.set(key, index);
    this.usedBytes += index.indexBytes;
  }

  private remove(key: string): boolean {
    const index = this.entries.get(key);
    if (!index) return false;
    this.entries.delete(key);
    this.usedBytes -= index.indexBytes;
    return true;
  }

  /** Drops resident indexes without deleting optional persisted sidecars. */
  evict(out: OutReader, request: SeriesRequest, sourceKey: string): boolean {
    return this.remove(this.key(out, request, sourceKey));
  }
  clear(): void { this.generation++; this.entries.clear(); this.usedBytes = 0; }
  stats(): OutIndexCacheStats {
    return {entries:this.entries.size, bytes:this.usedBytes, maxBytes:this.maxBytes,
      hits:this.hits, misses:this.misses, builds:this.builds,
      restores:this.restores, evictions:this.evictions, inflight:this.pending.size};
  }
}

export interface AdaptiveOutIndexOptions {
  /** Below this number of periods, always read directly. Default: 4096. */
  readonly minPeriods?: number;
  /** Minimum number of completed direct queries before promotion. Default: 4. */
  readonly promoteAfterQueries?: number;
  /** Avoid indexing when direct reads are already cheap. Default: 1 ms. */
  readonly minAverageDirectMs?: number;
}

export interface AdaptiveEnvelopeResult {
  readonly mode: 'direct' | 'indexed';
  readonly series: SeriesEnvelope;
}

/**
 * A conservative per-session policy, NOT a guarantee of globally optimal
 * break-even: observed direct-query latency and query counts guide promotion.
 * Cache hit always wins; admission is restricted by OutIndexCache's hard budget.
 * Query accounting is per source + channel and does not use a network server.
 */
export class AdaptiveOutIndex {
  private readonly accesses = new Map<string, {count:number; totalMs:number}>();
  readonly minPeriods: number;
  readonly promoteAfterQueries: number;
  readonly minAverageDirectMs: number;
  constructor(readonly cache: OutIndexCache, options: AdaptiveOutIndexOptions = {}) {
    this.minPeriods = options.minPeriods ?? 4096;
    this.promoteAfterQueries = options.promoteAfterQueries ?? 4;
    this.minAverageDirectMs = options.minAverageDirectMs ?? 1;
    if (!Number.isSafeInteger(this.minPeriods) || this.minPeriods < 1 ||
      !Number.isSafeInteger(this.promoteAfterQueries) || this.promoteAfterQueries < 1 ||
      !Number.isFinite(this.minAverageDirectMs) || this.minAverageDirectMs < 0)
      throw new RangeError('Invalid adaptive index policy');
  }

  async envelope(out: OutReader, request: SeriesRequest, sourceKey: string,
    start = 0, end = out.info.periods, maxPoints = 1000,
    readOptions?: OutReadOptions): Promise<AdaptiveEnvelopeResult> {
    throwIfAborted(readOptions?.signal);
    const index = this.cache.get(out, request, sourceKey);
    if (index) return {mode:'indexed', series:index.envelope(start,end,maxPoints,readOptions?.signal)};
    const info = out.info;
    const metricKey = JSON.stringify([sourceKey, info.version, info.periods, info.flowUnits,
      info.reportStepSeconds, info.bytesPerPeriod, info.nSubcatch, info.nNodes,
      info.nLinks, info.nPollutants, info.startDateSerial,
      request.kind, request.object, request.attribute]);
    const previous = this.accesses.get(metricKey);
    if (out.info.periods >= this.minPeriods && this.cache.canFit(out.info.periods) &&
      previous && previous.count >= this.promoteAfterQueries &&
      previous.totalMs / previous.count >= this.minAverageDirectMs) {
      const built = await this.cache.getOrBuild(out, request, sourceKey, {readOptions});
      return {mode:'indexed', series:built.envelope(start,end,maxPoints,readOptions?.signal)};
    }
    const began = performance.now();
    const series = await out.seriesEnvelope(request.kind, request.object, request.attribute,
      start,end,maxPoints,4096,readOptions);
    const elapsed = performance.now() - began;
    const stats = previous ?? {count:0,totalMs:0};
    stats.count++;
    stats.totalMs += elapsed;
    this.accesses.set(metricKey,stats);
    return {mode:'direct',series};
  }

  /** Reset observation history; does not evict resident indexes. */
  reset(): void { this.accesses.clear(); }
}
