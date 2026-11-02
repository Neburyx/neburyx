import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type { Definition } from '../definition.js';
import { writeExport } from '../export.js';
import { generate } from '../generate.js';
import type { MappingSource } from '../mapping.js';
import { miniDefinition, miniMapping } from './fixture.js';
import { readManifest } from './records.js';

const folders: string[] = [];
afterAll(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

export function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'demo-graph-test-'));
  folders.push(folder);
  return folder;
}

export function exportDirectory(seed = 1, mapping: MappingSource = miniMapping, definition: Definition = miniDefinition): string {
  const directory = join(scratch(), 'export');
  writeExport(directory, generate(mapping, definition, seed));
  return directory;
}

export const ENV = { MINI_USER: 'reader', MINI_PASSWORD: 'a password value' };

export function dataFile(directory: string, type: string): string {
  const entry = readManifest(directory).files.find((file) => file.type === type);
  if (entry === undefined) throw new Error('no such type in the manifest');
  return entry.file;
}
