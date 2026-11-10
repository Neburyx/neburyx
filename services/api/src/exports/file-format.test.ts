import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { exportFileSchema, exportHeaderSchema, type Count, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { csvCell, entitiesCsvOf, guardedText, relationshipsCsvOf } from './csv.js';
import { exportHeaderOf, notRetrievedLine } from './header.js';
import { exportJsonOf } from './json-file.js';
import { ZipTooLargeError, zipOf } from './zip.js';

const AT = new Date('2026-11-10T10:15:00.000Z');
const scope = 'not yet retrieved';
const counts: readonly [string, Count, string][] = [
  ['exact', { value: 5, quality: 'exact', scope }, '5 not yet retrieved (exact)'],
  ['estimated', { value: 38, quality: 'estimated', scope }, '~38 not yet retrieved (estimated)'],
  ['lower bound', { value: 500, quality: 'lowerBound', scope }, '≥ 500 not yet retrieved (lower bound)'],
  ['unknown', { quality: 'unknown', scope }, 'more not yet retrieved'],
];

const node = (id: string, properties: GraphNode['properties'] = [], title = id): GraphNode => ({
  ref: { sourceId: 'demo', entityType: 'widget', stableId: id },
  display: { title, type: 'Widget' },
  properties,
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});
const prop = (key: string, value: unknown, masked = false): GraphNode['properties'][number] => ({ key, value, dataClass: 'text', masked });
const edge = (id: string, extra: Partial<GraphEdge> = {}): GraphEdge => ({
  ref: { sourceId: 'demo', type: 'MADE_FROM', from: 'widget', to: 'gadget', stableId: id },
  from: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' },
  to: { sourceId: 'demo', entityType: 'gadget', stableId: 'GT-1' },
  type: 'MADE_FROM',
  direction: 'from-to',
  semantics: 'stored',
  properties: [],
  evidenceRefs: [],
  qualityFlags: [],
  ...extra,
});
const header = (over: Partial<Parameters<typeof exportHeaderOf>[0]> = {}) => exportHeaderOf({ source: 'demo', exportedAt: AT, shown: 10, notRetrieved: { value: 38, quality: 'estimated', scope }, maskedFields: 0, omitted: false, ...over });

describe('the export header', () => {
  it.each(counts)('states a %s count with its label, and no number when it is unknown', (_name, count, line) => {
    expect(notRetrievedLine(count)).toBe(line);
    const built = header({ notRetrieved: count });
    expect(built.lines).toEqual(['source: demo', 'exported: 2026-11-10T10:15:00.000Z', 'scope: current view (partial)', `coverage: 10 shown · ${line}`, 'masking: off']);
    expect(exportHeaderSchema.parse(built)).toEqual(built);
  });

  it('says how many fields are masked, and when something may not be exported, adds the fixed sentence with no number', () => {
    const built = header({ maskedFields: 4, omitted: true });
    expect(built.lines.slice(4)).toEqual(['masking: 4 critical fields masked', 'Some items may be hidden by your access.']);
    expect(built.masking).toEqual({ maskedFields: 4 });
    expect(header().masking).toBe('off');
    expect(JSON.stringify(header({ omitted: true }))).not.toMatch(/\d+ (items|elements) /);
  });

  it('reads 0 shown and 0 not yet retrieved for an empty selection', () => {
    const built = header({ shown: 0, notRetrieved: { value: 0, quality: 'exact', scope } });
    expect(built.lines[3]).toBe('coverage: 0 shown · 0 not yet retrieved (exact)');
  });
});

describe('the JSON file', () => {
  it('begins with the header, then the entities and relationships in a fixed order, the same bytes for the same read', () => {
    const entities = [node('W-2'), node('W-1')];
    const relationships = [edge('L-2'), edge('L-1')];
    const first = exportJsonOf(header(), entities, relationships);
    expect(Object.keys(JSON.parse(first.toString('utf8')))).toEqual(['header', 'entities', 'relationships']);
    expect(first).toEqual(exportJsonOf(header(), [...entities].reverse(), [...relationships].reverse()));
    const file = exportFileSchema.parse(JSON.parse(first.toString('utf8')));
    expect(file.entities.map((entry) => entry.ref.stableId)).toEqual(['W-1', 'W-2']);
  });

  it('keeps the masked flag of every property and a keyed id as it came', () => {
    const file = exportFileSchema.parse(JSON.parse(exportJsonOf(header(), [node('tok.abc', [prop('phone', '••••••', true)])], []).toString('utf8')));
    expect(file.entities[0]?.properties[0]?.masked).toBe(true);
    expect(file.entities[0]?.ref.stableId).toBe('tok.abc');
  });

  it('is built for an empty selection', () => {
    const file = exportFileSchema.parse(JSON.parse(exportJsonOf(header({ shown: 0 }), [], []).toString('utf8')));
    expect(file.entities).toEqual([]);
    expect(file.header.coverage.shown).toBe(0);
  });
});

/** A small RFC 4180 reader: quoted fields with doubled quotes, CRLF rows. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') (field += '"', (index += 1));
      else if (char === '"') quoted = false;
      else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') (row.push(field), (field = ''));
    else if (char === '\r' && text[index + 1] === '\n') (row.push(field), rows.push(row), (row = []), (field = ''), (index += 1));
    else field += char;
  }
  return rows;
}

describe('the CSV files', () => {
  const text = (bytes: Buffer) => bytes.toString('utf8').replace(/^﻿/, '');

  it.each([
    ['equals', '=1+1'], ['plus', '+1'], ['minus', '-2+3'], ['at', '@SUM(1)'], ['tab', '\t=1'], ['carriage return', '\r=1'], ['line feed', '\n=1'],
    ['leading spaces', '   =1+1'], ['a no-break space', ' =1'], ['a full-width equals', '＝1+1'], ['a full-width plus', '＋1'], ['a full-width minus', '－1'], ['a full-width at', '＠x'],
  ])('writes a cell starting with %s with a leading apostrophe', (_name, cell) => {
    expect(guardedText(cell)).toBe(`'${cell}`);
    expect(csvCell(cell).startsWith(`"'`)).toBe(true);
  });

  it.each(['plain', 'a=b', 'x+y', '1-2', 'name@example.test', '', "'quoted"])('leaves %j as it is', (cell) => {
    expect(guardedText(cell)).toBe(cell);
  });

  it('quotes every text cell and doubles quotes; a number is not text and an absent value is empty', () => {
    expect(csvCell('say "hi", ok')).toBe('"say ""hi"", ok"');
    expect(csvCell(7)).toBe('7');
    expect(csvCell(null)).toBe('');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
  });

  it('opens each file with the header lines as one field each, then the column row, with a byte-order mark and CRLF', () => {
    const bytes = entitiesCsvOf(header(), [node('W-1', [prop('note', 'x')])]);
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    const rows = parseCsv(text(bytes));
    expect(rows.slice(0, 5).map((row) => row.length)).toEqual([1, 1, 1, 1, 1]);
    expect(rows[0]).toEqual(['# source: demo']);
    expect(rows[3]).toEqual(['# coverage: 10 shown · ~38 not yet retrieved (estimated)']);
    expect(rows[5]).toEqual(['type', 'id', 'title', 'note']);
    expect(rows[6]).toEqual(['widget', 'W-1', 'W-1', 'x']);
    expect(text(bytes)).toContain('\r\n');
  });

  it('keeps a source name with a comma, a quote or a line break in one field of one row', () => {
    const odd = header({ source: 'a, "b"\n=cmd' });
    const rows = parseCsv(text(entitiesCsvOf(odd, [])));
    expect(rows[0]).toEqual(['# source: a, "b"\n=cmd']);
    expect(rows[0]).toHaveLength(1);
  });

  it('makes a column header that is a formula safe, and takes the sorted union of property keys with empty cells for missing ones', () => {
    const rows = parseCsv(text(entitiesCsvOf(header(), [node('W-1', [prop('=cmd', 'a'), prop('@sum', 'b')]), node('W-2', [prop('alpha', 'c')])])));
    expect(rows[5]).toEqual(['type', 'id', 'title', "'=cmd", "'@sum", 'alpha']);
    expect(rows[6]).toEqual(['widget', 'W-1', 'W-1', 'a', 'b', '']);
    expect(rows[7]).toEqual(['widget', 'W-2', 'W-2', '', '', 'c']);
  });

  it('neutralizes a title and a value that are formulas, and writes masked values as the gate returned them', () => {
    const rows = parseCsv(text(entitiesCsvOf(header(), [node('W-1', [prop('phone', '••••••', true), prop('note', '=HYPERLINK("http://x")')], '=1+1')])));
    expect(rows[6]).toEqual(['widget', 'W-1', "'=1+1", "'=HYPERLINK(\"http://x\")", '••••••']);
  });

  it('writes relationships with their kind and member count, and an unknown member count as an empty cell with its quality', () => {
    const aggregate = edge('A', {
      ref: { sourceId: 'demo', aggregate: { type: 'BARE', from: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, to: { sourceId: 'demo', entityType: 'gadget', stableId: 'GT-1' } } },
      type: 'BARE',
      memberCount: { quality: 'unknown', scope: 'aggregate:members' },
    });
    const counted = edge('B', {
      ref: { sourceId: 'demo', aggregate: { type: 'OTHER', from: { sourceId: 'demo', entityType: 'widget', stableId: 'W-1' }, to: { sourceId: 'demo', entityType: 'gadget', stableId: 'GT-1' } } },
      type: 'OTHER',
      memberCount: { value: 3, quality: 'exact', scope: 'aggregate:members' },
    });
    const rows = parseCsv(text(relationshipsCsvOf(header(), [edge('L-1'), aggregate, counted])));
    expect(rows[5]).toEqual(['type', 'id', 'from_type', 'from_id', 'to_type', 'to_id', 'kind', 'member_count', 'member_count_quality']);
    const byType = new Map(rows.slice(6).map((row) => [row[0], row]));
    expect(byType.get('MADE_FROM')).toEqual(['MADE_FROM', 'L-1', 'widget', 'W-1', 'gadget', 'GT-1', 'stored', '', '']);
    expect(byType.get('BARE')?.slice(6)).toEqual(['aggregate', '', 'unknown']);
    expect(byType.get('OTHER')?.slice(6)).toEqual(['aggregate', '3', 'exact']);
  });

  it('gives the same bytes for the same read in any order', () => {
    const a = entitiesCsvOf(header(), [node('W-2'), node('W-1')]);
    expect(a).toEqual(entitiesCsvOf(header(), [node('W-1'), node('W-2')]));
  });
});

describe('the zip', () => {
  const entries = [{ name: 'entities.csv', bytes: Buffer.from('a,b\r\n') }, { name: 'relationships.csv', bytes: Buffer.from('é,ü\r\n'.repeat(1000)) }];

  it('holds exactly the two entries, stored, with the right sizes and CRC-32', () => {
    const zip = zipOf(entries);
    expect(zip.readUInt32LE(0)).toBe(0x04034b50);
    expect(zip.readUInt16LE(8)).toBe(0);
    expect(zip.readUInt32LE(14)).toBe(crc32(entries[0]?.bytes ?? Buffer.alloc(0)));
    expect(zip.readUInt32LE(18)).toBe(entries[0]?.bytes.length);
    const end = zip.length - 22;
    expect(zip.readUInt32LE(end)).toBe(0x06054b50);
    expect(zip.readUInt16LE(end + 10)).toBe(2);
    expect(zip.readUInt16LE(end + 20)).toBe(0);
  });

  it('passes the system test and gives each entry back byte for byte', () => {
    const folder = mkdtempSync(join(tmpdir(), 'nbx-zip-'));
    const path = join(folder, 'x.zip');
    writeFileSync(path, zipOf(entries));
    let listing = '';
    try {
      listing = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') return;
      throw error;
    }
    expect(listing).toContain('No errors detected');
    expect(execFileSync('unzip', ['-p', path, 'entities.csv'])).toEqual(entries[0]?.bytes);
    expect(execFileSync('unzip', ['-p', path, 'relationships.csv'])).toEqual(entries[1]?.bytes);
  });

  it('carries nothing but the fixed names and gives the same bytes every time', () => {
    const zip = zipOf(entries);
    expect(zip.toString('latin1')).not.toMatch(/demo|W-1/);
    expect(zipOf(entries)).toEqual(zip);
  });

  it('refuses a name that is too long for the format', () => {
    expect(() => zipOf([{ name: 'x'.repeat(70_000), bytes: Buffer.alloc(0) }])).toThrow(ZipTooLargeError);
  });
});
