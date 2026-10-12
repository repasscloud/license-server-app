// RFC 4180 CSV reader: quoted fields, doubled quotes, embedded commas and newlines, CRLF or LF,
// and an optional UTF-8 BOM (spreadsheet exports and the stripe-catalogue script write one).

export interface CsvTable {
  headers: string[];
  /** Data rows keyed by header, with their 1-based line number in the file (header = line 1). */
  rows: Array<{ line: number; values: Record<string, string> }>;
}

export function parseCsv(text: string): CsvTable {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: Array<{ line: number; fields: string[] }> = [];
  let fields: string[] = [];
  let field = '';
  let quoted = false;
  let line = 1;
  let recordLine = 1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      quoted = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      fields.push(field);
      records.push({ line: recordLine, fields });
      fields = [];
      field = '';
      line++;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  if (quoted) throw new Error(`Unterminated quoted field starting on line ${recordLine}`);
  if (field !== '' || fields.length) {
    fields.push(field);
    records.push({ line: recordLine, fields });
  }
  const nonEmpty = records.filter((r) => r.fields.some((f) => f.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], rows: [] };
  const headers = nonEmpty[0]!.fields.map((h) => h.trim());
  if (new Set(headers).size !== headers.length) throw new Error('Duplicate CSV column');
  const rows = nonEmpty.slice(1).map((r) => {
    if (r.fields.length > headers.length) throw new Error(`Line ${r.line} has ${r.fields.length} fields; the header has ${headers.length}`);
    const values: Record<string, string> = {};
    headers.forEach((h, i) => (values[h] = (r.fields[i] ?? '').trim()));
    return { line: r.line, values };
  });
  return { headers, rows };
}
