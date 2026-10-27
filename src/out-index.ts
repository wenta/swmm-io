import { OutReader, type OutInfo, type OutReadOptions, type SeriesEnvelope, type SeriesRequest } from './out.js';
import { throwIfAborted } from './source.js';

/**
 * Indexes one selected output series, not a whole sewer network. The caller decides
 * which links/channels deserve indexing. A full city-wide index would be enormous.
 *
 * The complete binary tree stores min/max float32 values and their original period
 * numbers. The structure guarantees exact extrema over arbitrary integer ranges
 * without rescanning the original .out. Storage: 32*nextPowerOfTwo(periods) bytes,
 * plus a small metadata header when serialized. This is an explicit trade-off:
 * faster repeated charts at the cost of extra memory and a one-time full scan.
 */
export interface OutIndexBuildOptions {
  /**
   * Required when persisting an index: a stable, collision-resistant ID supplied
   * by the application (e.g. SHA-256 of the immutable OUT file). This is NOT a
   * secret. Do not use the filename alone: equal layouts can contain different data.
   */
  readonly sourceKey: string;
  /** Default: 256 MiB; includes only the tree arrays, not temporary input chunks. */
  readonly maxIndexBytes?: number;
  /** Default: 4096 periods. Does not materialize the entire time series. */
  readonly chunkPeriods?: number;
  readonly readOptions?: OutReadOptions;
}
export interface OutIndexLoadOptions {
  readonly sourceKey: string;
  readonly maxIndexBytes?: number;
  /** Optional protection against accidentally opening an index for a different channel. */
  readonly expectedRequest?: SeriesRequest;
}
export interface OutExtrema {
  readonly min: number;
  readonly minPeriod: number;
  readonly max: number;
  readonly maxPeriod: number;
}

const MAGIC = 'SWMXIDX1';
const VERSION = 1;
const DEFAULT_BUDGET = 256 * 1024 * 1024;
const encoder = new TextEncoder();
const nativeLittleEndian = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;
const decoder = new TextDecoder('utf-8', { fatal: true });
const empty = 0xffffffff;
// CRC32 detects accidental corruption in a stored sidecar. It is NOT
// cryptographic authentication and does not replace the app's sourceKey.
const crcTable = Uint32Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  return c >>> 0;
});
function crc32(data: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) crc = crcTable[(crc ^ data[i]!) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function budget(value: number | undefined): number {
  const result = value ?? DEFAULT_BUDGET;
  if (!Number.isSafeInteger(result) || result < 16) throw new RangeError('Invalid maxIndexBytes');
  return result;
}
function capacityFor(periods: number): number {
  if (!Number.isSafeInteger(periods) || periods < 1 || periods > 0xfffffffe) {
    throw new RangeError('OutSeriesIndex requires 1..4294967294 periods');
  }
  let capacity = 1;
  while (capacity < periods) capacity *= 2;
  return capacity;
}
function layout(info: OutInfo): string {
  // Fast sanity check; application-supplied sourceKey MUST authenticate data.
  return [info.version, info.flowUnits, info.periods, info.reportStepSeconds,
    info.bytesPerPeriod, info.nSubcatch, info.nNodes, info.nLinks,
    info.nPollutants, info.startDateSerial].join(':');
}
/** A reusable exact min/max tree for a single .out channel. */
export class OutSeriesIndex {
  /** Number of reporting periods indexed (entire output). */
  readonly periods: number;
  /** Bytes occupied by the four internal typed arrays; excludes JS metadata. */
  readonly indexBytes: number;
  private constructor(
    readonly request: SeriesRequest,
    readonly sourceKey: string,
    readonly sourceLayout: string,
    periods: number,
    private readonly capacity: number,
    private readonly mins: Float32Array,
    private readonly maxs: Float32Array,
    private readonly minAt: Uint32Array,
    private readonly maxAt: Uint32Array,
  ) {
    this.periods = periods;
    this.indexBytes = 4 * (mins.byteLength);
  }

  /**
   * Build the optional index with one bounded-memory pass over a selected series.
   * Large source records use sparse reads through OutReader rather than bulk
   * loading all links at each period. Abort and I/O budgets propagate unchanged.
   */
  static async build(out: OutReader, request: SeriesRequest, options: OutIndexBuildOptions): Promise<OutSeriesIndex> {
    if (!options || typeof options.sourceKey !== 'string' || !options.sourceKey || options.sourceKey.length > 512)
      throw new RangeError('A nonempty sourceKey (up to 512 chars) is required');
    const periods = out.info.periods;
    const capacity = capacityFor(periods);
    const bytes = capacity * 32;
    if (!Number.isSafeInteger(bytes) || bytes > budget(options.maxIndexBytes))
      throw new RangeError(`Index needs ${bytes} bytes; raise maxIndexBytes explicitly or index fewer channels`);
    const chunkPeriods = options.chunkPeriods ?? 4096;
    if (!Number.isSafeInteger(chunkPeriods) || chunkPeriods < 1 || chunkPeriods > 1_000_000)
      throw new RangeError('Invalid chunkPeriods');
    const slots = capacity * 2;
    const mins = new Float32Array(slots).fill(Infinity);
    const maxs = new Float32Array(slots).fill(-Infinity);
    const minAt = new Uint32Array(slots).fill(empty);
    const maxAt = new Uint32Array(slots).fill(empty);

    for await (const { start, values } of out.seriesChunks(request.kind, request.object, request.attribute,
      0, periods, chunkPeriods, 'auto', options.readOptions)) {
      throwIfAborted(options.readOptions?.signal);
      for (let j = 0; j < values.length; j++) {
        const i = start + j;
        const value = values[j]!;
        // Leaves retain NaN/Infinity as originally read so small-range charts
        // and range endpoints preserve the original data bit-pattern semantics.
        mins[capacity + i] = value;
        maxs[capacity + i] = value;
        if (Number.isFinite(value)) { minAt[capacity + i] = i; maxAt[capacity + i] = i; }
      }
    }
    for (let i = capacity - 1; i >= 1; i--) {
      if ((i & 16383) === 0) throwIfAborted(options.readOptions?.signal);
      const l = i * 2, r = l + 1;
      const a = minAt[l]!, b = minAt[r]!;
      if (a !== empty && (b === empty || mins[l]! <= mins[r]!)) {
        mins[i] = mins[l]!; minAt[i] = a;
      } else if (b !== empty) {
        mins[i] = mins[r]!; minAt[i] = b;
      }
      const c = maxAt[l]!, d = maxAt[r]!;
      if (c !== empty && (d === empty || maxs[l]! >= maxs[r]!)) {
        maxs[i] = maxs[l]!; maxAt[i] = c;
      } else if (d !== empty) {
        maxs[i] = maxs[r]!; maxAt[i] = d;
      }
    }
    return new OutSeriesIndex({ ...request }, options.sourceKey, layout(out.info), periods,
      capacity, mins, maxs, minAt, maxAt);
  }

  /** Fetch the exact original Float32 value at a single reporting period. */
  value(period: number): number {
    this.checkRange(period, period + 1);
    return this.mins[this.capacity + period]!;
  }

  /**
   * Exact finite extrema for [start,end), or null if no finite sample exists.
   * O(log(periods)) time, no original SWMM data reads. Equal extrema pick the
   * earliest reporting period for deterministic, stable chart output.
   */
  extrema(start = 0, end = this.periods): OutExtrema | null {
    this.checkRange(start, end);
    if (start === end) return null;
    let l = start + this.capacity, r = end + this.capacity;
    let low = Infinity, high = -Infinity, lowAt = empty, highAt = empty;
    const accept = (node: number): void => {
      const a = this.minAt[node]!;
      if (a !== empty && (lowAt === empty || this.mins[node]! < low || (this.mins[node] === low && a < lowAt))) {
        low = this.mins[node]!; lowAt = a;
      }
      const b = this.maxAt[node]!;
      if (b !== empty && (highAt === empty || this.maxs[node]! > high || (this.maxs[node] === high && b < highAt))) {
        high = this.maxs[node]!; highAt = b;
      }
    };
    while (l < r) {
      if (l % 2) accept(l++);
      if (r % 2) accept(--r);
      l = Math.floor(l / 2); r = Math.floor(r / 2);
    }
    return lowAt === empty ? null : { min: low, minPeriod: lowAt, max: high, maxPeriod: highAt };
  }

  /**
   * Identical bucket semantics to OutReader.seriesEnvelope(), including first
   * and last samples, non-finite endpoints, and sorted spike positions. Unlike
   * the raw reader, repeated queries require ZERO calls to ByteSource.read.
   */
  envelope(start = 0, end = this.periods, maxPoints = 1000, signal?: AbortSignal): SeriesEnvelope {
    this.checkRange(start, end);
    throwIfAborted(signal);
    if (!Number.isSafeInteger(maxPoints) || maxPoints < 4 || maxPoints > 20_000_000)
      throw new RangeError('Invalid maxPoints');
    const n = end - start;
    if (n === 0) return { periods: new Uint32Array(0), values: new Float32Array(0) };
    if (n <= maxPoints) {
      const x = new Uint32Array(n), y = new Float32Array(n);
      for (let i = 0; i < n; i++) { if ((i & 4095) === 0) throwIfAborted(signal); x[i] = start + i; y[i] = this.value(start + i); }
      return { periods: x, values: y };
    }
    const buckets = Math.min(n - 2, Math.floor((maxPoints - 2) / 2));
    const x: number[] = [start], y: number[] = [this.value(start)];
    for (let b = 0; b < buckets; b++) {
      if ((b & 255) === 0) throwIfAborted(signal);
      const lo = start + 1 + Math.ceil(b * (n - 2) / buckets);
      const hi = start + 1 + Math.ceil((b + 1) * (n - 2) / buckets);
      const extrema = this.extrema(lo, hi);
      if (!extrema) continue;
      const { minPeriod, maxPeriod, min, max } = extrema;
      if (minPeriod === maxPeriod) { x.push(minPeriod); y.push(min); }
      else if (minPeriod < maxPeriod) { x.push(minPeriod, maxPeriod); y.push(min, max); }
      else { x.push(maxPeriod, minPeriod); y.push(max, min); }
    }
    x.push(end - 1); y.push(this.value(end - 1));
    return { periods: Uint32Array.from(x), values: Float32Array.from(y) };
  }

  /** Portable binary sidecar; does not include source OUT data. */
  serialize(): Uint8Array {
    const metadata = encoder.encode(JSON.stringify({
      version: VERSION, sourceKey: this.sourceKey, sourceLayout: this.sourceLayout,
      periods: this.periods, capacity: this.capacity, request: this.request
    }));
    const prefix = 12 + metadata.length;
    const payloadStart = Math.ceil(prefix / 4) * 4;
    const total = payloadStart + this.indexBytes + 4;
    const bytes = new Uint8Array(total);
    for (let i = 0; i < MAGIC.length; i++) bytes[i] = MAGIC.charCodeAt(i);
    new DataView(bytes.buffer).setUint32(8, metadata.length, true);
    bytes.set(metadata, 12);
    let at = payloadStart;
    const view = new DataView(bytes.buffer);
    for (const array of [this.mins, this.maxs, this.minAt, this.maxAt]) {
      if (nativeLittleEndian) {
        bytes.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), at);
      } else {
        // Rare big-endian runtime fallback: the serialized format is ALWAYS LE.
        if (array instanceof Float32Array) for (let i = 0; i < array.length; i++)
          view.setFloat32(at + i * 4, array[i]!, true);
        else for (let i = 0; i < array.length; i++) view.setUint32(at + i * 4, array[i]!, true);
      }
      at += array.byteLength;
    }
    new DataView(bytes.buffer).setUint32(total - 4, crc32(bytes, 8, total - 4), true);
    return bytes;
  }

  /**
   * Restore a sidecar only when the owning app supplies the matching immutable
   * sourceKey (ideally a content hash) AND .out layout matches. Structural metadata
   * alone cannot guarantee the original simulation values are unchanged.
   */
  static restore(out: OutReader, input: Uint8Array, options: OutIndexLoadOptions): OutSeriesIndex {
    if (!(input instanceof Uint8Array) || input.length < 16) throw new Error('Invalid OUT index header');
    for (let i = 0; i < MAGIC.length; i++) if (input[i] !== MAGIC.charCodeAt(i)) throw new Error('Invalid OUT index magic');
    const readView = new DataView(input.buffer, input.byteOffset, input.byteLength);
    const recordedCrc = readView.getUint32(input.length - 4, true);
    if (crc32(input, 8, input.length - 4) !== recordedCrc) throw new Error('OUT index checksum mismatch');
    const headerSize = readView.getUint32(8, true);
    if (headerSize > 8192 || 12 + headerSize > input.length) throw new Error('Invalid OUT index metadata length');
    let header: Record<string, unknown>;
    try { header = JSON.parse(decoder.decode(input.subarray(12, 12 + headerSize))) as Record<string, unknown>; }
    catch { throw new Error('Invalid OUT index metadata JSON'); }
    const expected = layout(out.info);
    if (header.version !== VERSION || header.sourceLayout !== expected || header.sourceKey !== options.sourceKey)
      throw new Error('OUT index is incompatible with sourceKey or SWMM output layout');
    const periods = out.info.periods;
    const capacity = capacityFor(periods);
    if (header.periods !== periods || header.capacity !== capacity) throw new Error('Invalid OUT index period count');
    const req = header.request as SeriesRequest | undefined;
    if (!req || !['subcatch', 'node', 'link', 'system'].includes(req.kind) ||
      (typeof req.object !== 'number' && typeof req.object !== 'string') ||
      (typeof req.attribute !== 'number' && typeof req.attribute !== 'string'))
      throw new Error('Invalid OUT index series request');
    const expectedRequest = options.expectedRequest;
    if (expectedRequest && (req.kind !== expectedRequest.kind || req.object !== expectedRequest.object ||
      req.attribute !== expectedRequest.attribute)) throw new Error('OUT index series request mismatch');
    const byteLength = capacity * 32;
    if (byteLength > budget(options.maxIndexBytes)) throw new RangeError('OUT index exceeds maxIndexBytes');
    const offset = Math.ceil((12 + headerSize) / 4) * 4;
    if (offset + byteLength + 4 !== input.length) throw new Error('Truncated or trailing OUT index data');
    // One defensive copy: typed arrays require aligned buffers and the caller
    // must not mutate an index after it is accepted into a cache.
    const payload = new Uint8Array(byteLength);
    payload.set(input.subarray(offset, input.length - 4));
    const count = capacity * 2;
    const mins = new Float32Array(payload.buffer, 0, count);
    const maxs = new Float32Array(payload.buffer, count * 4, count);
    const minAt = new Uint32Array(payload.buffer, count * 8, count);
    const maxAt = new Uint32Array(payload.buffer, count * 12, count);
    if (!nativeLittleEndian) {
      const view = new DataView(payload.buffer);
      // Build native-endian arrays into a new, owned buffer.
      for (let i = 0; i < count; i++) {
        mins[i] = view.getFloat32(i * 4, true);
        maxs[i] = view.getFloat32(count * 4 + i * 4, true);
        minAt[i] = view.getUint32(count * 8 + i * 4, true);
        maxAt[i] = view.getUint32(count * 12 + i * 4, true);
      }
    }
    // Verify no corrupt pointers can escape the memory bounds; validation is
    // linear once at load, not repeated for every chart query.
    for (let i = 1; i < count; i++) {
      const a = minAt[i]!, b = maxAt[i]!;
      if ((a !== empty && a >= periods) || (b !== empty && b >= periods))
        throw new Error('Invalid OUT index period pointer');
    }
    return new OutSeriesIndex({ ...req }, options.sourceKey, expected, periods, capacity, mins, maxs, minAt, maxAt);
  }

  private checkRange(start: number, end: number): void {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > this.periods || start > end)
      throw new RangeError(`Invalid OUT index period range [${start},${end})`);
  }
}
