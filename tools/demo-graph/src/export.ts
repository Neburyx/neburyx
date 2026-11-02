import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Generated } from './generate.js';

export interface ManifestEntry {
  readonly kind: 'entity' | 'relationship';
  readonly type: string;
  readonly label: string;
  readonly from: string;
  readonly to: string;
  readonly file: string;
  readonly count: number;
  readonly sha256: string;
}

export interface Manifest {
  readonly version: 1;
  readonly seed: number;
  readonly sourceId: string;
  readonly files: readonly ManifestEntry[];
}

export class ExportExistsError extends Error {}

/** A type name as a file name: anything outside letters, digits, underscore and hyphen becomes ~hex~, so no name can leave the folder or collide. */
export function encodeName(name: string): string {
  return Array.from(name, (character) => (/[A-Za-z0-9_-]/.test(character) ? character : `~${(character.codePointAt(0) ?? 0).toString(16)}~`)).join('');
}

export function writeExport(directory: string, generated: Generated): Manifest {
  if (existsSync(directory) && readdirSync(directory).length > 0) throw new ExportExistsError('the export directory already holds files; name a new directory');
  mkdirSync(join(directory, 'nodes'), { recursive: true });
  mkdirSync(join(directory, 'relationships'), { recursive: true });
  const counters = { entity: 0, relationship: 0 };
  const files = generated.files.map((file): ManifestEntry => {
    const position = String(counters[file.kind]++).padStart(3, '0');
    const path = join(file.kind === 'entity' ? 'nodes' : 'relationships', `${position}-${encodeName(file.type)}.jsonl`);
    const bytes = Buffer.from(file.lines.length === 0 ? '' : `${file.lines.join('\n')}\n`, 'utf8');
    writeFileSync(join(directory, path), bytes);
    return { kind: file.kind, type: file.type, label: file.label, from: file.from, to: file.to, file: path.split('\\').join('/'), count: file.lines.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  const manifest: Manifest = { version: 1, seed: generated.seed, sourceId: generated.sourceId, files };
  writeFileSync(join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
