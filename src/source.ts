/** Random-access byte source, compatible with browser and Node.js. */
export interface SourceReadOptions { readonly signal?: AbortSignal; }
/** Cooperative cancellation for operations using ByteSource. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('SWMM read aborted');
    error.name = 'AbortError';
    throw error;
  }
}
export interface ByteSource {
  readonly size: number;
  /** Must return exactly length bytes or throw. */
  read(offset: number, length: number, options?: SourceReadOptions): Promise<Uint8Array>;
  close?(): Promise<void>;
}

function checkBounds(size: number, offset: number, length: number): void {
  if (!Number.isSafeInteger(size) || !Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
    offset < 0 || length < 0 || offset > size || length > size - offset) {
    throw new RangeError(`Invalid read range [${offset}, ${offset + length}) for ${size} bytes`);
  }
}

export class MemorySource implements ByteSource {
  readonly size: number;
  readonly view: DataView;
  constructor(data: Uint8Array | ArrayBuffer) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.size = bytes.byteLength;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.bytes = bytes;
  }
  private readonly bytes: Uint8Array;
  async read(offset: number, length: number, options: SourceReadOptions = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal);
    checkBounds(this.size, offset, length);
    return this.bytes.subarray(offset, offset + length);
  }
}

/** Uses Blob.slice to load only requested ranges, no whole-file read. */
export class BlobSource implements ByteSource {
  readonly size: number;
  constructor(private readonly blob: Blob) { this.size = blob.size; }
  async read(offset: number, length: number, options: SourceReadOptions = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal);
    checkBounds(this.size, offset, length);
    const bytes = new Uint8Array(await this.blob.slice(offset, offset + length).arrayBuffer());
    throwIfAborted(options.signal);
    if (bytes.length !== length) throw new Error('Unexpected end of Blob');
    return bytes;
  }
}

/**
 * Use with a Node.js fs/promises FileHandle: await open(path, 'r');
 * Handle is injected so browser entrypoint never imports node built-ins.
 */
export interface PositionedReader {
  read(buffer: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export class FileHandleSource implements ByteSource {
  constructor(readonly size: number, private readonly handle: PositionedReader) {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Invalid file size');
  }
  async read(offset: number, length: number, options: SourceReadOptions = {}): Promise<Uint8Array> {
    throwIfAborted(options.signal);
    checkBounds(this.size, offset, length);
    const buf = new Uint8Array(length);
    let n = 0;
    while (n < length) {
      throwIfAborted(options.signal);
      const r = await this.handle.read(buf, n, length - n, offset + n);
      if (r.bytesRead === 0) throw new Error('Unexpected end of file');
      n += r.bytesRead;
    }
    throwIfAborted(options.signal);
    return buf;
  }
  async close(): Promise<void> { await this.handle.close(); }
}
