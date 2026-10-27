export interface RptSection {
  readonly title: string;
  readonly line: number;
  /** The unmodified text between this section's title and the next section. */
  readonly body: string;
}
export interface RptMessage {
  readonly level: 'error' | 'warning';
  readonly line: number;
  readonly text: string;
}

/** Fast, read-only SWMM report reader. Report tables differ by SWMM version. */
export class RptDocument {
  private readonly blocks: readonly RptSection[];
  private readonly diagnostics: readonly RptMessage[];

  private constructor(private readonly source: string) {
    const starts: { title: string; line: number; end: number; start: number }[] = [];
    const warnings: RptMessage[] = [];
    const lines: { text: string; start: number; end: number }[] = [];
    let at = 0;
    while (at < source.length) {
      const next = source.indexOf('\n', at);
      const end = next === -1 ? source.length : next;
      lines.push({ text: source.slice(at, end).replace(/\r$/, ''), start: at, end: next === -1 ? source.length : next + 1 });
      at = end < source.length ? end + 1 : end;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.text;
      const match = /\b(ERROR|WARNING)\s*(?:\d+)?\s*:/i.exec(line);
      if (match) warnings.push({ level: match[1]!.toLowerCase() as 'error' | 'warning', line: i + 1, text: line.trim() });
      // EPA uses a banner made from at least 5 stars, title, then stars.
      if (/^\s*\*{5,}\s*$/.test(line) && i + 2 < lines.length &&
          /^\s*\*{5,}\s*$/.test(lines[i + 2]!.text)) {
        const title = lines[i + 1]!.text.trim();
        if (title && !/^\*+$/.test(title)) starts.push({ title, line: i + 2, start: lines[i]!.start, end: lines[i + 2]!.end });
      }
    }
    this.blocks = starts.map((part, index) => ({
      title: part.title, line: part.line,
      body: source.slice(part.end, starts[index + 1]?.start ?? source.length)
    }));
    this.diagnostics = warnings;
  }

  static parse(text: string): RptDocument { return new RptDocument(text); }
  get sections(): readonly RptSection[] { return this.blocks; }
  get messages(): readonly RptMessage[] { return this.diagnostics; }
  get errors(): readonly RptMessage[] { return this.diagnostics.filter(d => d.level === 'error'); }
  get warnings(): readonly RptMessage[] { return this.diagnostics.filter(d => d.level === 'warning'); }
  toString(): string { return this.source; }
  /** May return multiple occurrences of the same section title. */
  sectionsNamed(title: string): readonly RptSection[] {
    const key = title.trim().toLowerCase();
    return this.blocks.filter(s => s.title.toLowerCase() === key);
  }
  /** Continuity error values in percent when those blocks are present. */
  continuityErrors(): ReadonlyMap<string, number> {
    const values = new Map<string, number>();
    for (const section of this.blocks) {
      if (!/continuity/i.test(section.title)) continue;
      const m = /Continuity Error\s*\(%\)\s*\.{2,}\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/i.exec(section.body);
      if (m) values.set(section.title, Number(m[1]));
    }
    return values;
  }
}
