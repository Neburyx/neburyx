import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDefinition, readDefinition } from './definition.js';
import { writeExport } from './export.js';
import { generate, type Generated } from './generate.js';
import { readMappingSource } from './mapping.js';
import { packFiles } from './packs.js';
import { readPreset } from './preset.js';

const DAY = 86_400_000;
const PACK = 'banking-fraud';
const files = packFiles(PACK);
const mapping = readMappingSource(files.mapping);
const definition = readDefinition(files.definition, mapping);
const anchor = readPreset(files.cases)?.entity.id ?? '';

interface Edge {
  readonly f: string;
  readonly t: string;
  readonly p: Record<string, { $datetime?: string } | undefined>;
}

const parseEdge = (line: string): Edge => JSON.parse(line) as Edge;
const edgesOf = (generated: Generated, type: string): Edge[] => (generated.files.find((file) => file.kind === 'relationship' && file.type === type)?.lines ?? []).map(parseEdge);
const at = (value: { $datetime?: string } | undefined): number => Date.parse(value?.$datetime ?? '');

/**
 * The questions about the last 7, 30 and 90 days, answered from the generated data with the windows the product uses, measured at 00:00 UTC on the build day (the start of the day is the earliest `now` of that day):
 * 7 days is whole UTC days up to the end of the build day; 30 and 90 days are the last N x 24 hours up to now.
 */
describe.each(['2026-09-30', '2027-09-30', '2028-09-30'])('the banking demo built on %s', (buildDay) => {
  const generated = generate(mapping, definition, definition.seed, buildDay);
  const start = Date.parse(`${buildDay}T00:00:00Z`);
  const inLast = (value: { $datetime?: string } | undefined, days: number, wholeDays = false): boolean => at(value) >= start - days * DAY && at(value) < (wholeDays ? start + DAY : start);

  it('has the preset account on a device it used in the last 7 days', () => {
    expect(edgesOf(generated, 'USES_DEVICE').filter((edge) => edge.f === anchor && inLast(edge.p.lastSeen, 7, true)).length).toBeGreaterThan(0);
  });

  it('has the preset account on a device that another account used too, both in the last 90 days', () => {
    const edges = edgesOf(generated, 'USES_DEVICE');
    const own = new Set(edges.filter((edge) => edge.f === anchor && inLast(edge.p.lastSeen, 90)).map((edge) => edge.t));
    expect(edges.some((edge) => edge.f !== anchor && own.has(edge.t) && inLast(edge.p.lastSeen, 90))).toBe(true);
  });

  it('has the preset account on a transaction it initiated in the last 30 days, and every transaction one initiating account', () => {
    const edges = edgesOf(generated, 'INITIATED');
    expect(edges.filter((edge) => edge.f === anchor && inLast(edge.p.initiatedAt, 30)).length).toBeGreaterThanOrEqual(10);
    expect(edges).toHaveLength(120_000);
    expect(new Set(edges.map((edge) => edge.t)).size).toBe(120_000);
  });
});

describe('the banking demo data that the window questions do not touch', () => {
  it('is the same at every build day, up to the dates', () => {
    const strip = (generated: Generated) => generated.files.map((file) => file.lines.map((line) => line.replace(/"\$date(time)?":"[^"]+"/g, '"$d":"-"')));
    expect(strip(generate(mapping, definition, definition.seed, '2026-09-30'))).toEqual(strip(generate(mapping, definition, definition.seed, '2028-01-15')));
  });
});

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

describe.each(['banking-fraud', 'insurance-claims'])('the %s demo built for its reference date', (pack) => {
  const packFile = packFiles(pack);
  const packMapping = readMappingSource(packFile.mapping);
  const packDefinition = readDefinition(packFile.definition, packMapping);

  it('is byte-identical to the build with no build date, and its manifest differs only by the build date', () => {
    const plain = generate(packMapping, packDefinition, packDefinition.seed);
    const dated = generate(packMapping, packDefinition, packDefinition.seed, '2026-09-30');
    expect(dated.files.map((file) => file.lines)).toEqual(plain.files.map((file) => file.lines));
    const written = [plain, dated].map((generated) => {
      const folder = mkdtempSync(join(tmpdir(), 'demo-windows-'));
      folders.push(folder);
      const directory = join(folder, 'export');
      writeExport(directory, generated);
      return JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown>;
    });
    const { buildDate, ...rest } = written[1] ?? {};
    expect(buildDate).toBe('2026-09-30');
    expect(rest).toEqual(written[0]);
  });
});

describe('the banking demo against its definition before the recent dates were added', () => {
  const text = readFileSync(files.definition, 'utf8');
  const RING = 'from: "2026-09-25T00:00:00Z", to: "2026-09-29T23:59:59Z"';
  const WHOLE = 'from: "2025-01-01T00:00:00Z", to: "2026-09-30T23:59:59Z"';
  const marker = '  # The last ten transactions';
  const start = text.indexOf(marker);
  const end = text.indexOf('  - type: PAID_TO');
  const before = text.slice(0, start).replace('    toRange: { start: 0, count: 119990 }\n', '').replaceAll(RING, WHOLE) + text.slice(end);
  const old = generate(mapping, parseDefinition(before, mapping), definition.seed, '2026-09-30');
  const now = generate(mapping, definition, definition.seed, '2026-09-30');
  const linesOfFile = (generated: Generated, type: string, kind: 'entity' | 'relationship') => generated.files.find((file) => file.type === type && file.kind === kind)?.lines ?? [];

  it('holds the old definition as text that the markers found', () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(before).not.toContain(RING);
  });

  it('leaves every entity file and every other relationship file as it was', () => {
    for (const file of old.files) {
      if (['USES_DEVICE', 'CONNECTS_FROM', 'INITIATED'].includes(file.type) && file.kind === 'relationship') continue;
      expect(linesOfFile(now, file.type, file.kind), file.type).toEqual(file.lines);
    }
  });

  it('changes the two ring relationship files only in the last-seen time of the 240 lines of their ring block, which come last, and the initiated file only in the initiator and time of its last ten lines', () => {
    const ring = definition.blocks.filter((block) => block.pattern === 'ring' && ['USES_DEVICE', 'CONNECTS_FROM'].includes(block.type));
    expect(ring.map((block) => block.groups * block.size)).toEqual([240, 240]);
    for (const type of ['USES_DEVICE', 'CONNECTS_FROM']) {
      const before = linesOfFile(old, type, 'relationship');
      const after = linesOfFile(now, type, 'relationship');
      expect(after).toHaveLength(before.length);
      const firstRing = before.length - 240;
      expect(after.slice(0, firstRing), type).toEqual(before.slice(0, firstRing));
      for (const [index, line] of before.slice(firstRing).entries()) {
        const a = parseEdge(line);
        const b = parseEdge(after[firstRing + index] ?? '{}');
        expect({ ...b, p: { ...b.p, lastSeen: undefined } }, `${type} ${index}`).toEqual({ ...a, p: { ...a.p, lastSeen: undefined } });
      }
    }
    const before = linesOfFile(old, 'INITIATED', 'relationship');
    const after = linesOfFile(now, 'INITIATED', 'relationship');
    expect(after.slice(0, 119_990)).toEqual(before.slice(0, 119_990));
    for (const [index, line] of before.slice(119_990).entries()) {
      const a = parseEdge(line);
      const b = parseEdge(after[119_990 + index] ?? '{}');
      expect(b.f).toBe(anchor);
      expect({ ...b, f: '', p: { ...b.p, initiatedAt: undefined } }, `INITIATED ${index}`).toEqual({ ...a, f: '', p: { ...a.p, initiatedAt: undefined } });
    }
  });
});
