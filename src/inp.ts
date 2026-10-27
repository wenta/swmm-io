/** Lossless, read-only, section-indexed EPA SWMM .inp scanner. */
export interface InpRow {
  readonly section: string;
  readonly line: number;
  readonly fields: readonly string[];
  readonly comment: string | undefined;
}

interface Span { readonly start: number; readonly end: number; readonly line: number; }
interface RowIndex {
  readonly ids: Map<string, number | number[]>;
  readonly offsets: Uint32Array;
  readonly lines: Uint32Array;
}


/**
 * Zero-dependency .inp reader. Construction indexes section boundaries and
 * does not materialize records; section rows are parsed only on iteration.
 * toString() always reproduces the original file unchanged.
 */
export class InpDocument {
  private readonly spans = new Map<string, Span[]>();
  // Indexed only when callers request lookups. No per-record objects allocated
  // during InpDocument.parse(), even for very large INP files.
  private readonly idIndexes = new Map<string, RowIndex>();
  private constructor(private readonly source: string) {
    let offset = 0;
    let line = 1;
    let current: string | undefined;
    let spanStart = 0;
    let sectionLine = 0;
    while (offset < source.length) {
      const start = offset;
      let next = source.indexOf('\n', offset);
      if (next === -1) next = source.length;
      offset = next < source.length ? next + 1 : next;
      let a = start;
      while (a < next && isWhitespace(source.charCodeAt(a))) a++;
      if (a === 0 && source.charCodeAt(a) === 0xfeff) a++; // UTF-8 BOM decoded by TextDecoder
      if (source.charCodeAt(a) === 91) { // '['
        const close = source.indexOf(']', a + 1);
        if (close !== -1 && close < next) {
          const name = source.slice(a + 1, close).trim().toUpperCase();
          const trailing = source.slice(close + 1, next).trim();
          if (name && (trailing === '' || trailing[0] === ';')) {
            if (current !== undefined) this.add(current, { start: spanStart, end: start, line: sectionLine });
            current = name;
            spanStart = offset;
            sectionLine = line + 1;
          }
        }
      }
      line++;
    }
    if (current !== undefined) this.add(current, { start: spanStart, end: source.length, line: sectionLine });
  }

  static parse(text: string): InpDocument { return new InpDocument(text); }

  get sections(): readonly string[] { return [...this.spans.keys()]; }
  hasSection(section: string): boolean { return this.spans.has(section.toUpperCase()); }
  toString(): string { return this.source; }

  *rows(section: string): IterableIterator<InpRow> {
    const key = section.toUpperCase();
    for (const span of this.spans.get(key) ?? []) {
      let i = span.start;
      let line = span.line;
      while (i < span.end) {
        const begin = i;
        let end = this.source.indexOf('\n', begin);
        if (end === -1 || end > span.end) end = span.end;
        i = end < span.end ? end + 1 : end;
        const row = tokenize(this.source, begin, end);
        if (row.fields.length) yield { section: key, line, ...row };
        line++;
      }
    }
  }

  /**
   * Indexed ID lookup. The first query for one section performs one linear scan
   * using only the first token of each row; later lookups avoid rescanning.
   * Duplicate IDs (legal in e.g. CURVES/TIMESERIES) are preserved.
   * Index memory is proportional only to the queried section, not the model.
   */
  rowById(section: string, id: string): InpRow | undefined {
    const index=this.locations(section);
    const pos=index.ids.get(id);
    if (pos === undefined) return undefined;
    return this.at(section.toUpperCase(),index,Array.isArray(pos)?pos[0]!:pos);
  }

  *rowsById(section: string, id: string): IterableIterator<InpRow> {
    const index=this.locations(section);
    const pos=index.ids.get(id);
    if (pos === undefined) return;
    const key = section.toUpperCase();
    if (Array.isArray(pos)) for (const i of pos) yield this.at(key,index,i);
    else yield this.at(key,index,pos);
  }

  private at(section: string, index: RowIndex, row: number): InpRow {
    const start=index.offsets[row]!, line=index.lines[row]!;
    let end = this.source.indexOf('\n',start);
    if (end === -1) end = this.source.length;
    return {section, line, ...tokenize(this.source,start,end)};
  }

  private locations(section: string): RowIndex {
    const key = section.toUpperCase();
    const cached = this.idIndexes.get(key);
    if (cached) return cached;
    const ids = new Map<string, number | number[]>();
    // Rather than allocating one {start,line} object per record, keep compact
    // packed integer arrays and map each ID to a 0-based position.
    let offsets=new Uint32Array(2048),lines=new Uint32Array(2048),length=0;
    for (const span of this.spans.get(key) ?? []) {
      let start = span.start, line = span.line;
      while (start < span.end) {
        let end = this.source.indexOf('\n',start);
        if (end < 0 || end > span.end) end = span.end;
        const id = firstField(this.source,start,end);
        if (id !== undefined) {
          if (length===offsets.length) {
            const nextOffsets=new Uint32Array(offsets.length*2);
            const nextLines=new Uint32Array(lines.length*2);
            nextOffsets.set(offsets);nextLines.set(lines);
            offsets=nextOffsets;lines=nextLines;
          }
          if (start > 0xffffffff || line > 0xffffffff) throw new RangeError('INP index exceeds Uint32 supported range');
          offsets[length]=start;lines[length]=line;
          const previous = ids.get(id);
          if (previous === undefined) ids.set(id,length);
          else if (Array.isArray(previous)) previous.push(length);
          else ids.set(id,[previous,length]);
          length++;
        }
        start = end < span.end ? end + 1 : end;
        line++;
      }
    }
    const index:RowIndex={ids,offsets:offsets.slice(0,length),lines:lines.slice(0,length)};
    this.idIndexes.set(key,index);
    return index;
  }

  /**
   * Number of data records in a section, including repeated sections and
   * repeated IDs. The first call builds the usual compact positional index;
   * subsequent calls are O(1). Empty/unknown sections return zero.
   *
   * @remarks The index is shared with rowById and cached numeric columns;
   * no second ID map is allocated by a column store.
   */
  sectionRowCount(section: string): number {
    return this.locations(section).offsets.length;
  }

  /**
   * Position (zero-based) of the FIRST record with this ID, or undefined.
   * Duplicate identifiers can represent multiple curve/time-series points;
   * those remain accessible through rowsById().
   */
  rowPosition(section: string, id: string): number | undefined {
    const result = this.locations(section).ids.get(id);
    return Array.isArray(result) ? result[0] : result;
  }

  /**
   * Scan only selected zero-based token positions, once per record.
   *
   * The `fields` array passed to the callback is a REUSED scratch buffer.
   * Read its values synchronously; callers MUST NOT retain or modify it.
   * Quoted tokens and comments follow the same rules as rows(). Duplicate
   * section headers and IDs are scanned in original document order.
   *
   * @param positions Requested token positions, in desired output order.
   * @param accept Receives document record position, ID and requested tokens.
   * @internal Intended for large, eager numeric column materialization.
   */
  forEachSelectedFields(
    section: string,
    positions: readonly number[],
    accept: (rowIndex: number, id: string, fields: readonly (string | undefined)[]) => void
  ): void {
    if (!positions.length) return;
    const slots = new Map<number, number[]>();
    let highest = 0;
    for (let i = 0; i < positions.length; i++) {
      const pos = positions[i]!;
      if (!Number.isSafeInteger(pos) || pos < 0) throw new RangeError('Invalid token position');
      highest = Math.max(highest, pos);
      const existing = slots.get(pos);
      if (existing) existing.push(i);
      else slots.set(pos, [i]);
    }
    const fields: (string | undefined)[] = new Array(positions.length);
    const index = this.locations(section);
    const input = this.source;
    for (let row = 0; row < index.offsets.length; row++) {
      const start = index.offsets[row]!;
      let end = input.indexOf('\n', start);
      if (end === -1) end = input.length;
      fields.fill(undefined);
      let cursor = start;
      let tokenIndex = 0;
      let id: string | undefined;
      while (cursor < end && tokenIndex <= highest) {
        while (cursor < end && isWhitespace(input.charCodeAt(cursor))) cursor++;
        if (cursor >= end || input.charCodeAt(cursor) === 59) break;
        const quote = input.charCodeAt(cursor);
        let a = cursor, b: number;
        if (quote === 34 || quote === 39) {
          a = ++cursor;
          while (cursor < end && input.charCodeAt(cursor) !== quote) cursor++;
          b = cursor;
          if (cursor < end) cursor++;
        } else {
          while (cursor < end && !isWhitespace(input.charCodeAt(cursor)) && input.charCodeAt(cursor) !== 59) cursor++;
          b = cursor;
        }
        if (tokenIndex === 0) id = input.slice(a, b);
        const requested = slots.get(tokenIndex);
        if (requested) {
          const token = input.slice(a, b);
          for (const slot of requested) fields[slot] = token;
        }
        tokenIndex++;
      }
      // This should be impossible for an indexed row unless the source
      // changes; keeping the invariant explicit prevents shifted columns.
      if (id === undefined) throw new Error(`Missing indexed record ID at ${start}`);
      accept(row, id, fields);
    }
  }

  /**
   * Column scan without allocating an array of tokens / InpRow per record.
   * Particularly useful for extracting numeric columns from million-row INPs.
   */
  forEachField(section: string, index: number, accept: (id: string, field: string | undefined) => void): void {
    if (!Number.isSafeInteger(index) || index < 0) throw new RangeError('Invalid field index');
    const key = section.toUpperCase();
    for (const span of this.spans.get(key) ?? []) {
      let start = span.start;
      while (start < span.end) {
        let end = this.source.indexOf('\n', start);
        if (end < 0 || end > span.end) end = span.end;
        const id = firstField(this.source,start,end);
        if (id !== undefined) {
          accept(id,index === 0 ? id : nthField(this.source,start,end,index));
        }
        start = end < span.end ? end+1 : end;
      }
    }
  }

  /** Returns just the identifiers from a section; useful for model indexes. */
  *ids(section: string): IterableIterator<string> {
    for (const row of this.rows(section)) {
      const id = row.fields[0];
      if (id !== undefined) yield id;
    }
  }

  /**
   * Replace one unambiguous identified record without touching comments or line endings.
   * Existing trailing comments and leading indentation are preserved.
   */
  replaceRow(section: string, id: string, fields: readonly string[]): InpDocument {
    const matches = [...this.rows(section)].filter(row => row.fields[0] === id);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${section} row with ID ${id}; found ${matches.length}`);
    if (fields.length === 0 || fields[0] !== id) throw new Error('Replacement ID must match original ID');
    const { start, end } = this.lineRange(matches[0]!.line);
    const oldLine = this.source.slice(start, end);
    const indentation = oldLine.match(/^[ \t]*/)?.[0] ?? '';
    const commentPos = findComment(oldLine);
    const comment = commentPos === -1 ? '' : ' ' + oldLine.slice(commentPos);
    return InpDocument.parse(this.source.slice(0, start) + indentation + formatFields(fields) + comment + this.source.slice(end));
  }

  /** Remove exactly one identified record; other source text is byte-for-byte unchanged. */
  removeRow(section: string, id: string): InpDocument {
    const matches = [...this.rows(section)].filter(row => row.fields[0] === id);
    if (matches.length !== 1) throw new Error(`Expected exactly one ${section} row with ID ${id}; found ${matches.length}`);
    const { start, endWithNewline } = this.lineRange(matches[0]!.line);
    return InpDocument.parse(this.source.slice(0, start) + this.source.slice(endWithNewline));
  }

  /** Append a record to the last occurrence of a section, preserving its neighbors. */
  appendRow(section: string, fields: readonly string[]): InpDocument {
    const key = section.toUpperCase();
    const spans = this.spans.get(key);
    if (!spans?.length) throw new Error(`Cannot append to missing section ${key}`);
    const span = spans[spans.length - 1]!;
    const newline = this.source.includes('\r\n') ? '\r\n' : '\n';
    const before = this.source.slice(0, span.end);
    const prefix = before.length > 0 && !before.endsWith('\n') ? newline : '';
    return InpDocument.parse(before + prefix + formatFields(fields) + newline + this.source.slice(span.end));
  }

  private lineRange(target: number): { start: number; end: number; endWithNewline: number } {
    let start = 0;
    for (let n = 1; n < target; n++) {
      const newline = this.source.indexOf('\n', start);
      if (newline === -1) throw new RangeError('Unknown source line');
      start = newline + 1;
    }
    const newline = this.source.indexOf('\n', start);
    const end = newline === -1 ? this.source.length :
      (newline > start && this.source.charCodeAt(newline - 1) === 13 ? newline - 1 : newline);
    return { start, end, endWithNewline: newline === -1 ? this.source.length : newline + 1 };
  }

  private add(section: string, span: Span): void {
    const list = this.spans.get(section);
    if (list === undefined) this.spans.set(section, [span]);
    else list.push(span);
  }
}

/** Returns only the record identifier, without splitting the rest of the row. */
function firstField(text: string, start: number, end: number): string | undefined {
  let i = start;
  while (i < end && isWhitespace(text.charCodeAt(i))) i++;
  if (i >= end || text.charCodeAt(i) === 59) return undefined;
  const quote = text.charCodeAt(i);
  if (quote === 34 || quote === 39) {
    const a = ++i;
    while (i < end && text.charCodeAt(i) !== quote) i++;
    return text.slice(a,i);
  }
  const a = i;
  while (i < end && !isWhitespace(text.charCodeAt(i)) && text.charCodeAt(i) !== 59) i++;
  return i === a ? undefined : text.slice(a,i);
}

/** Single positional token scanner, minimizing allocations vs tokenize(). */
function nthField(text: string, start: number, end: number, index: number): string | undefined {
  let i=start,field=0;
  while(i<end) {
    while(i<end && isWhitespace(text.charCodeAt(i)))i++;
    if(i>=end || text.charCodeAt(i)===59) return undefined;
    let a: number, b: number;
    const quote=text.charCodeAt(i);
    if(quote===34 || quote===39) {
      a=++i;
      while(i<end && text.charCodeAt(i)!==quote) i++;
      b=i;
      if(i<end)i++;
    } else {
      a=i;
      while(i<end && !isWhitespace(text.charCodeAt(i)) && text.charCodeAt(i)!==59)i++;
      b=i;
    }
    if(field===index) return text.slice(a,b);
    field++;
  }
  return undefined;
}

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 13 || code === 10;
}

/** Tokenize without regex splits; semicolons outside quotes begin comments. */
function tokenize(text: string, start: number, end: number): { fields: string[]; comment: string | undefined } {
  const fields: string[] = [];
  let comment: string | undefined;
  let i = start;
  while (i < end) {
    while (i < end && isWhitespace(text.charCodeAt(i))) i++;
    if (i === end) break;
    if (text.charCodeAt(i) === 59) {
      comment = text.slice(i + 1, end).trimEnd();
      break;
    }
    let token: string;
    const quote = text.charCodeAt(i);
    if (quote === 34 || quote === 39) {
      i++;
      const a = i;
      while (i < end && text.charCodeAt(i) !== quote) i++;
      token = text.slice(a, i);
      if (i < end) i++;
    } else {
      const a = i;
      while (i < end && !isWhitespace(text.charCodeAt(i)) && text.charCodeAt(i) !== 59) i++;
      token = text.slice(a, i);
    }
    fields.push(token);
  }
  return { fields, comment };
}

function formatFields(fields: readonly string[]): string {
  if (fields.length === 0) throw new Error('Empty INP record');
  return fields.map(field => {
    if (field.includes('\n') || field.includes('\r') || field.includes(';')) throw new Error('Cannot emit newline or semicolon in INP field');
    if (field.includes('"') || field.includes("'")) throw new Error('Quoted strings with internal quote characters are not supported by this writer');
    return /\s/.test(field) ? '"' + field + '"' : field;
  }).join(' ');
}
function findComment(line: string): number {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) { if (c === quote) quote = ''; }
    else if (c === '"' || c === "'") quote = c;
    else if (c === ';') return i;
  }
  return -1;
}
