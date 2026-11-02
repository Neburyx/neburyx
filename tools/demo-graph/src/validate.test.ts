import { createHash } from 'node:crypto';
import { readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadExport } from './load.js';
import { ExportError, readExport } from './validate.js';
import { ENV, dataFile, exportDirectory } from './testing/export-helpers.js';
import { parseLine, readManifest, type LooseManifest } from './testing/records.js';
import { miniMapping } from './testing/fixture.js';
import { recordingDriver } from './testing/recording-driver.js';

function rewriteManifest(directory: string, change: (manifest: LooseManifest) => void): void {
  const manifest = readManifest(directory);
  change(manifest);
  writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
}

function replaceFile(directory: string, file: string, text: string): void {
  writeFileSync(join(directory, file), text);
  rewriteManifest(directory, (manifest) => {
    const entry = manifest.files.find((candidate) => candidate.file === file);
    if (entry === undefined) throw new Error('no such file in the manifest');
    entry.sha256 = createHash('sha256').update(text).digest('hex');
    entry.count = text === '' ? 0 : text.trimEnd().split('\n').length;
  });
}

const WIDGET = (directory: string) => dataFile(directory, 'widget');
const GADGET = (directory: string) => dataFile(directory, 'gadget');
const NEAR = (directory: string) => dataFile(directory, 'NEAR');
const HAS = (directory: string) => dataFile(directory, 'HAS');

function firstLine(directory: string, file: string): ReturnType<typeof parseLine> {
  return parseLine(readFileSync(join(directory, file), 'utf8').split('\n')[0] ?? '{}');
}

const damages: readonly (readonly [string, (directory: string) => void, (directory: string) => string])[] = [
  ['an unreadable manifest', (directory) => writeFileSync(join(directory, 'manifest.json'), 'not json'), () => 'manifest.json'],
  ['a manifest of another version', (directory) => rewriteManifest(directory, (manifest) => (manifest.version = 2)), () => 'manifest.json'],
  ['a file name that leaves the export', (directory) => rewriteManifest(directory, (manifest) => void (manifest.files[0] && (manifest.files[0].file = '../outside.jsonl'))), () => 'manifest.json'],
  ['a missing data file', (directory) => rmSync(join(directory, WIDGET(directory))), WIDGET],
  ['a corrupt data file', (directory) => writeFileSync(join(directory, WIDGET(directory)), readFileSync(join(directory, WIDGET(directory)), 'utf8').replace('W0001', 'W9999')), WIDGET],
  ['a truncated data file', (directory) => truncateSync(join(directory, GADGET(directory)), 20), GADGET],
  ['a count that does not match', (directory) => rewriteManifest(directory, (manifest) => void (manifest.files[0] && (manifest.files[0].count += 1))), WIDGET],
  ['a line that is not JSON', (directory) => replaceFile(directory, WIDGET(directory), 'not json\n'), WIDGET],
  ['a value with an unknown tag', (directory) => replaceFile(directory, WIDGET(directory), '{"p":{"widgetId":{"$surprise":"1"}}}\n'), WIDGET],
  ['an integer beyond 64 bits', (directory) => replaceFile(directory, WIDGET(directory), '{"p":{"widgetId":{"$int":"9223372036854775808"}}}\n'), WIDGET],
  ['an integer below 64 bits', (directory) => replaceFile(directory, WIDGET(directory), '{"p":{"widgetId":{"$int":"-9223372036854775809"}}}\n'), WIDGET],
  ['a date that is not a calendar day', (directory) => replaceFile(directory, WIDGET(directory), '{"p":{"widgetId":{"$date":"2020-02-30"}}}\n'), WIDGET],
  ['a date-time that is not a time', (directory) => replaceFile(directory, WIDGET(directory), '{"p":{"widgetId":{"$datetime":"2020-01-01T25:00:00Z"}}}\n'), WIDGET],
  ['a record without its stable ID', (directory) => replaceFile(directory, WIDGET(directory), '{"p":{"colour":"red"}}\n'), WIDGET],
  ['a repeated stable ID', (directory) => replaceFile(directory, WIDGET(directory), '{"p":{"widgetId":"W1"}}\n{"p":{"widgetId":"W1"}}\n'), WIDGET],
  ['a property the mapping does not use', (directory) => replaceFile(directory, WIDGET(directory), '{"p":{"widgetId":"W1","surprise":"x"}}\n'), WIDGET],
  ['a relationship that names no ends', (directory) => replaceFile(directory, NEAR(directory), '{"p":{}}\n'), NEAR],
  ['a relationship to a node the export does not hold', (directory) => replaceFile(directory, NEAR(directory), '{"f":"W0001","t":"NOBODY","p":{}}\n'), NEAR],
  ['a relationship without its stable ID', (directory) => replaceFile(directory, HAS(directory), '{"f":"W0001","t":"G001","p":{}}\n'), HAS],
  ['a repeated relationship stable ID', (directory) => replaceFile(directory, HAS(directory), '{"f":"W0001","t":"G001","p":{"linkId":"L1"}}\n{"f":"W0002","t":"G001","p":{"linkId":"L1"}}\n'), HAS],
  ['a type listed twice', (directory) => rewriteManifest(directory, (manifest) => void (manifest.files[0] && manifest.files.push({ ...manifest.files[0] }))), () => 'manifest.json'],
];

describe('an export that is damaged', () => {
  it.each(damages)('is refused for %s, naming the file, before any connection and with the database unchanged', async (_name, damage, fileOf) => {
    const directory = exportDirectory();
    const file = fileOf(directory);
    damage(directory);
    const { factory, recording } = recordingDriver();
    const attempt = loadExport({ directory, source: miniMapping, env: ENV, reset: true, createDriver: factory });
    await expect(attempt).rejects.toThrow(ExportError);
    await expect(attempt).rejects.toThrow(file);
    expect(recording.drivers).toBe(0);
    expect(recording.statements).toEqual([]);
  });

  it('is refused when it was made for another source or lists a type the mapping does not have', async () => {
    const other = exportDirectory();
    rewriteManifest(other, (manifest) => (manifest.sourceId = 'another-source'));
    const unknown = exportDirectory();
    rewriteManifest(unknown, (manifest) => void (manifest.files[0] && (manifest.files[0].label = 'Other')));
    for (const directory of [other, unknown]) {
      const { factory, recording } = recordingDriver();
      await expect(loadExport({ directory, source: miniMapping, env: ENV, reset: false, createDriver: factory })).rejects.toThrow(ExportError);
      expect(recording.drivers).toBe(0);
    }
  });

  it('is accepted when nothing is damaged, with typed values read back', () => {
    const data = readExport(exportDirectory());
    expect(data.entities.map((entity) => entity.type)).toEqual(['widget', 'gadget']);
    expect(data.entities[1]?.rows[0]?.['serial']).toEqual({ $int: expect.stringMatching(/^90071992547409\d\d$/) });
    expect(firstLine(exportDirectory(), 'nodes/000-widget.jsonl')).toHaveProperty('p');
  });
});
