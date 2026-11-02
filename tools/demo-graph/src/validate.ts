import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { Manifest } from './export.js';
import type { Value } from './rules.js';

export class ExportError extends Error {
  readonly file: string;

  constructor(file: string, problem: string) {
    super(`${file}: ${problem}`);
    this.name = 'ExportError';
    this.file = file;
  }
}

const FILE_NAME = /^(?:nodes|relationships)\/\d{3}-[A-Za-z0-9_~-]+\.jsonl$/;

const manifestSchema = z.strictObject({
  version: z.literal(1),
  seed: z.number().int(),
  sourceId: z.string().min(1),
  files: z.array(
    z.strictObject({
      kind: z.enum(['entity', 'relationship']),
      type: z.string().min(1),
      label: z.string(),
      from: z.string(),
      to: z.string(),
      file: z.string().regex(FILE_NAME),
      count: z.number().int().min(0),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    }),
  ),
});

export type Properties = Record<string, Value>;

export interface ExportedEntity {
  readonly file: string;
  readonly type: string;
  readonly label: string;
  readonly rows: readonly Properties[];
}

export interface ExportedRelationship {
  readonly file: string;
  readonly type: string;
  readonly from: string;
  readonly to: string;
  readonly rows: readonly { readonly f: string; readonly t: string; readonly p: Properties }[];
}

export interface ExportData {
  readonly manifest: Manifest;
  readonly entities: readonly ExportedEntity[];
  readonly relationships: readonly ExportedRelationship[];
}

const INT = /^-?\d{1,19}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

function isInt64(text: string): boolean {
  const value = BigInt(text);
  return value >= INT64_MIN && value <= INT64_MAX;
}

function isCalendarDay(text: string): boolean {
  const time = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === text;
}

function isUtcTime(text: string): boolean {
  const time = Date.parse(text);
  return !Number.isNaN(time) && `${new Date(time).toISOString().slice(0, 19)}Z` === text;
}

function valueOf(raw: unknown, file: string, line: number): Value {
  if (typeof raw === 'string' || typeof raw === 'boolean') return raw;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    const keys = Object.keys(raw);
    const tag = keys.length === 1 ? keys[0] : undefined;
    const body: unknown = tag === undefined ? undefined : Reflect.get(raw, tag);
    if (tag === '$int' && typeof body === 'string' && INT.test(body) && isInt64(body)) return { $int: body };
    if (tag === '$date' && typeof body === 'string' && DAY.test(body) && isCalendarDay(body)) return { $date: body };
    if (tag === '$datetime' && typeof body === 'string' && DATE_TIME.test(body) && isUtcTime(body)) return { $datetime: body };
  }
  throw new ExportError(file, `line ${line} holds a value of a kind the loader does not know`);
}

function propertiesOf(raw: unknown, file: string, line: number): Properties {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new ExportError(file, `line ${line} has no properties`);
  const properties: Properties = {};
  for (const [key, value] of Object.entries(raw)) properties[key] = valueOf(value, file, line);
  return properties;
}

function linesOf(directory: string, entry: Manifest['files'][number]): string[] {
  let bytes: Buffer;
  try {
    bytes = readFileSync(join(directory, entry.file));
  } catch {
    throw new ExportError(entry.file, 'is listed in the manifest and cannot be read');
  }
  if (createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new ExportError(entry.file, 'does not match its SHA-256 in the manifest');
  const text = bytes.toString('utf8');
  const lines = text === '' ? [] : text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
  if (lines.length !== entry.count) throw new ExportError(entry.file, 'does not hold the number of records the manifest gives');
  return lines;
}

function recordOf(line: string, file: string, number: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ExportError(file, `line ${number} is not valid JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new ExportError(file, `line ${number} is not a record`);
  return Object.fromEntries(Object.entries(parsed));
}

/** Reads and checks a whole export before anything is written anywhere: manifest, files, hashes, counts and typed records. */
export function readExport(directory: string): ExportData {
  let manifest: Manifest;
  try {
    manifest = manifestSchema.parse(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8')));
  } catch {
    throw new ExportError('manifest.json', 'is missing or is not a manifest the loader reads');
  }
  const entities: ExportedEntity[] = [];
  const relationships: ExportedRelationship[] = [];
  for (const entry of manifest.files) {
    const lines = linesOf(directory, entry);
    if (entry.kind === 'entity') {
      entities.push({ file: entry.file, type: entry.type, label: entry.label, rows: lines.map((line, index) => propertiesOf(recordOf(line, entry.file, index + 1)['p'], entry.file, index + 1)) });
    } else {
      relationships.push({
        file: entry.file,
        type: entry.type,
        from: entry.from,
        to: entry.to,
        rows: lines.map((line, index) => {
          const record = recordOf(line, entry.file, index + 1);
          const { f, t } = record;
          if (typeof f !== 'string' || typeof t !== 'string') throw new ExportError(entry.file, `line ${index + 1} does not name both ends`);
          return { f, t, p: propertiesOf(record['p'], entry.file, index + 1) };
        }),
      });
    }
  }
  return { manifest, entities, relationships };
}
