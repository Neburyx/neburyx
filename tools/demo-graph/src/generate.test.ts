import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { parseDefinition } from './definition.js';
import { encodeName, ExportExistsError, writeExport } from './export.js';
import type { MappingSource } from './mapping.js';
import { readExport } from './validate.js';
import { generate } from './generate.js';
import { z } from 'zod';
import { miniDefinition, miniDefinitionText, miniMapping } from './testing/fixture.js';
import { linesOf, parseLine, readManifest, tagText } from './testing/records.js';

const folder = mkdtempSync(join(tmpdir(), 'demo-graph-'));
afterAll(() => rmSync(folder, { recursive: true, force: true }));

let counter = 0;
function exportWith(seed: number): string {
  counter += 1;
  const directory = join(folder, `export-${counter}`);
  writeExport(directory, generate(miniMapping, miniDefinition, seed));
  return directory;
}

function bytesOf(directory: string): Map<string, string> {
  const files = new Map<string, string>();
  for (const sub of ['nodes', 'relationships']) for (const name of readdirSync(join(directory, sub)).sort()) files.set(`${sub}/${name}`, readFileSync(join(directory, sub, name), 'utf8'));
  return files;
}

describe('the export of a definition', () => {
  it('is byte-identical for the same seed, manifest included', () => {
    const first = exportWith(11);
    const second = exportWith(11);
    expect(bytesOf(first)).toEqual(bytesOf(second));
    expect(readFileSync(join(first, 'manifest.json'), 'utf8')).toBe(readFileSync(join(second, 'manifest.json'), 'utf8'));
  });

  it('differs in its data files for another seed', () => {
    const left = bytesOf(exportWith(11));
    const right = bytesOf(exportWith(12));
    expect([...left].some(([file, text]) => right.get(file) !== text)).toBe(true);
  });

  it('writes a manifest whose counts equal the lines of the files', () => {
    const directory = exportWith(11);
    const manifest = readManifest(directory);
    expect(manifest.files.map((file) => [file.type, file.count])).toEqual([
      ['widget', 50],
      ['gadget', 20],
      ['HAS', expect.any(Number)],
      ['NEAR', expect.any(Number)],
    ]);
    for (const file of manifest.files) {
      const text = readFileSync(join(directory, file.file), 'utf8');
      expect(text.split('\n').filter((line) => line !== '')).toHaveLength(file.count);
    }
  });
});

describe('the generated records', () => {
  const generated = generate(miniMapping, miniDefinition, 11);
  const lines = (type: string) => linesOf(generated, type);

  it('give every node its own identifier and every relationship nodes that exist', () => {
    const widgets = lines('widget');
    const gadgets = lines('gadget');
    const widgetIds = new Set(widgets.map((node) => node.p.widgetId));
    const gadgetIds = new Set(gadgets.map((node) => node.p.gadgetId));
    expect(widgetIds.size).toBe(50);
    expect(gadgetIds.size).toBe(20);
    for (const edge of lines('HAS')) {
      expect(widgetIds.has(edge.f)).toBe(true);
      expect(gadgetIds.has(edge.t)).toBe(true);
    }
    const linkIds = lines('HAS').map((edge) => edge.p.linkId);
    expect(new Set(linkIds).size).toBe(linkIds.length);
  });

  it('draw a choice from its list, an integer, a decimal and a date within their bounds', () => {
    expect(new Set(lines('widget').map((node) => node.p.colour))).toEqual(new Set(['red', 'green', 'blue']));
    for (const node of lines('gadget')) {
      expect(Number(tagText(node.p.size, '$int'))).toBeGreaterThanOrEqual(1);
      expect(Number(tagText(node.p.size, '$int'))).toBeLessThanOrEqual(9);
      expect(node.p.weight).toBeGreaterThanOrEqual(0.5);
      expect(node.p.weight).toBeLessThanOrEqual(9.5);
      const madeOn = tagText(node.p.madeOn, '$date');
      expect(madeOn >= '2020-01-01' && madeOn <= '2020-12-31').toBe(true);
      const serial = BigInt(tagText(node.p.serial, '$int'));
      expect(serial >= 9007199254740993n && serial <= 9007199254740999n).toBe(true);
    }
  });

  it('leave out about the stated share of an optional value, within five standard deviations', () => {
    const edges = lines('HAS');
    const left = edges.filter((edge) => edge.p.seenAt === undefined).length;
    const expected = edges.length * 0.2;
    const deviation = Math.sqrt(edges.length * 0.2 * 0.8);
    expect(Math.abs(left - expected)).toBeLessThanOrEqual(5 * deviation);
    expect(left).toBeGreaterThan(0);
  });

  it('apply a byIndex rule to its index range and its default elsewhere', () => {
    expect(lines('gadget').map((node) => node.p.isCommon)).toEqual([true, true, ...Array(18).fill(false)]);
  });
});

describe('the values the rules give', () => {
  const generated = generate(miniMapping, miniDefinition, 11);
  const lines = (type: string) => linesOf(generated, type);

  it('give a datetime within its bounds and in the exact export form', () => {
    const seen = lines('HAS').flatMap((edge) => (edge.p.seenAt === undefined ? [] : [tagText(edge.p.seenAt, '$datetime')]));
    expect(seen.length).toBeGreaterThan(0);
    for (const value of seen) {
      expect(value).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
      expect(value >= '2026-01-01T00:00:00Z' && value <= '2026-06-30T23:59:59Z').toBe(true);
    }
  });

  it('give the exact text of a join of fixed text and a sequence, and of a sequence with a prefix and width', () => {
    expect(lines('gadget').map((node) => node.p.batch)).toEqual(Array.from({ length: 20 }, (_unused, index) => `B-${String(index).padStart(3, '0')}`));
    expect(lines('widget').map((node) => node.p.widgetId).slice(0, 3)).toEqual(['W0000', 'W0001', 'W0002']);
    expect(lines('HAS').map((edge) => edge.p.source).slice(0, 2)).toEqual(['rec-00000', 'rec-00001']);
  });

  it('follow the weights of a choice', () => {
    const document = parseDocument(miniDefinitionText);
    document.setIn(['entities', 'widget', 'count'], 4000);
    document.setIn(['entities', 'widget', 'properties', 'colour'], { choice: ['red', 'green', 'blue'], weights: [1, 1, 8] });
    const heavy = generate(miniMapping, parseDefinition(String(document), miniMapping), 3);
    const colours = linesOf(heavy, 'widget').map((node) => node.p.colour);
    const share = colours.filter((colour) => colour === 'blue').length / colours.length;
    expect(share).toBeGreaterThan(0.76);
    expect(share).toBeLessThan(0.84);
  });

  it('give a decimal that is a multiple of its step inside its bounds, also when the bounds sit on the step', () => {
    const document = parseDocument(miniDefinitionText);
    document.setIn(['entities', 'gadget', 'properties', 'weight'], { decimal: { min: 0.1, max: 0.3, places: 1 } });
    const narrow = generate(miniMapping, parseDefinition(String(document), miniMapping), 3);
    const weights = new Set(linesOf(narrow, 'gadget').map((node) => node.p.weight));
    expect([...weights].every((weight) => typeof weight === 'number' && [0.1, 0.2, 0.3].includes(weight))).toBe(true);
    expect(weights.size).toBeGreaterThan(1);
  });
});

describe('independence of the output from the order of the definition', () => {
  it('gives the same bytes when the properties of the definition are written in another order', () => {
    const reordered = parseDocument(miniDefinitionText);
    const properties = reordered.getIn(['entities', 'gadget', 'properties']);
    const entries = Object.entries(z.record(z.string(), z.unknown()).parse(JSON.parse(JSON.stringify(properties)))).reverse();
    reordered.setIn(['entities', 'gadget', 'properties'], Object.fromEntries(entries));
    const left = generate(miniMapping, miniDefinition, 4);
    const right = generate(miniMapping, parseDefinition(String(reordered), miniMapping), 4);
    expect(right.files.map((file) => file.lines)).toEqual(left.files.map((file) => file.lines));
  });

  it('leaves the values of the other properties unchanged when a property is removed', () => {
    const smaller = parseDocument(miniDefinitionText);
    smaller.deleteIn(['entities', 'gadget', 'properties', 'weight']);
    const left = generate(miniMapping, miniDefinition, 4);
    const right = generate(miniMapping, parseDefinition(String(smaller), miniMapping), 4);
    const gadgets = (generated: typeof left) =>
      (generated.files.find((file) => file.type === 'gadget')?.lines ?? []).map((line) => {
        const { p } = parseLine(line);
        delete p['weight'];
        return p;
      });
    expect(gadgets(right)).toEqual(gadgets(left));
  });
});

describe('file names in an export', () => {
  it.each([
    ['../../outside', '~2e~~2e~~2f~~2e~~2e~~2f~outside'],
    ['a/b', 'a~2f~b'],
    ['a~2f~b', 'a~7e~2f~7e~b'],
    ['Café', 'Caf~e9~'],
  ])('encodes %s so that it names no other place and no other type', (name, encoded) => {
    expect(encodeName(name)).toBe(encoded);
  });

  it('writes the files of strangely named types inside the export, and the loader reads them back', () => {
    const odd: MappingSource = {
      ...miniMapping,
      entities: miniMapping.entities.map((entity, index) => (index === 0 ? { ...entity, type: '../../outside' } : entity)),
      relationships: miniMapping.relationships.map((relationship) => ({ ...relationship, from: relationship.from === 'widget' ? '../../outside' : relationship.from, to: relationship.to === 'widget' ? '../../outside' : relationship.to })),
    };
    const text = miniDefinitionText.replace(/^ {2}widget:/m, "  '../../outside':").replace(/from: widget/g, "from: '../../outside'").replace(/to: widget/g, "to: '../../outside'");
    const directory = join(folder, 'odd-export');
    const manifest = writeExport(directory, generate(odd, parseDefinition(text, odd), 2));
    expect(manifest.files.every((file) => /^(nodes|relationships)\/\d{3}-[A-Za-z0-9_~-]+\.jsonl$/.test(file.file))).toBe(true);
    expect(readdirSync(join(directory, 'nodes')).length).toBe(2);
    expect(readExport(directory).entities.map((entity) => entity.type)).toContain('../../outside');
  });

  it('refuses to write into a directory that already holds files', () => {
    const directory = exportWith(1);
    expect(() => writeExport(directory, generate(miniMapping, miniDefinition, 1))).toThrow(ExportExistsError);
  });
});
