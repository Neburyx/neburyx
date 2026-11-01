import { closeSync, openSync, readSync } from 'node:fs';
import { LineCounter, parseDocument, type Document } from 'yaml';
import type { ZodIssue } from 'zod';
import { buildMapping } from './build.js';
import { decodeYaml } from './decode.js';
import { MappingError, pathOf, type MappingIssue } from './diagnostics.js';
import type { MappingModel } from './model.js';
import { mappingFileSchema } from './schema.js';
import { subsetProblems } from './subset.js';

export const MAX_MAPPING_BYTES = 1024 * 1024;

const MAX_IDENTIFIER_LENGTH = 80;
const MAX_ICON_LENGTH = 40;
const CONTEXT_SECTIONS: ReadonlyMap<string, { readonly label: string; readonly key: string }> = new Map([
  ['entities', { label: 'entity', key: 'type' }],
  ['relationships', { label: 'relationship', key: 'type' }],
  ['derived', { label: 'derived rule', key: 'id' }],
  ['patterns', { label: 'pattern', key: 'id' }],
]);

type Segments = readonly (string | number)[];

function valueAt(data: unknown, segments: Segments): unknown {
  let current = data;
  for (const segment of segments) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = Array.isArray(current) ? current[Number(segment)] : Object.getOwnPropertyDescriptor(current, segment)?.value;
  }
  return current;
}

function identifierAt(data: unknown, segments: Segments): string | undefined {
  const value = valueAt(data, segments);
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH ? value : undefined;
}

function contextOf(data: unknown, segments: Segments): string | undefined {
  const [root, index, section, position] = segments;
  if (root !== 'sources' || typeof index !== 'number') return undefined;
  const parts: string[] = [];
  const source = identifierAt(data, ['sources', index, 'id']);
  if (source !== undefined) parts.push(`source ${source}`);
  const described = typeof section === 'string' ? CONTEXT_SECTIONS.get(section) : undefined;
  if (described !== undefined && typeof position === 'number') {
    const name = identifierAt(data, ['sources', index, section ?? '', position, described.key]);
    if (name !== undefined) parts.push(`${described.label} ${name}`);
  }
  return parts.length > 0 ? parts.join(', ') : undefined;
}

function reasonFor(issue: ZodIssue, data: unknown): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.message.endsWith('received undefined') ? 'is required' : `must be ${issue.expected}`;
    case 'too_big':
      return `must be at most ${String(issue.maximum)}`;
    case 'too_small':
      return issue.origin === 'string' || issue.origin === 'array' ? 'must not be empty' : `must be at least ${String(issue.minimum)}`;
    case 'invalid_value': {
      const allowed = `must be one of ${issue.values.map(String).join(', ')}`;
      const icon = issue.path.at(-1) === 'icon' ? valueAt(data, issue.path.filter((segment): segment is string | number => typeof segment !== 'symbol')) : undefined;
      if (typeof icon !== 'string') return allowed;
      const shown = icon.length > MAX_ICON_LENGTH ? `${JSON.stringify(icon.slice(0, MAX_ICON_LENGTH)).slice(0, -1)}…"` : JSON.stringify(icon);
      return `${allowed} (got ${shown})`;
    }
    case 'unrecognized_keys':
      return 'is not a known key';
    case 'invalid_union':
      return 'is not plain data (text, numbers, true or false, lists and maps)';
    case 'invalid_format':
      return 'has an invalid format';
    case 'custom':
      return issue.message;
    default:
      return 'is invalid';
  }
}

function zodSegments(issue: ZodIssue): Segments[] {
  const path = issue.path.filter((segment): segment is string | number => typeof segment !== 'symbol');
  return issue.code === 'unrecognized_keys' ? issue.keys.map((key) => [...path, key]) : [path];
}

function locate(document: Document, lines: LineCounter, segments: Segments): Pick<MappingIssue, 'line' | 'column'> {
  for (let length = segments.length; length >= 0; length--) {
    const node = length === 0 ? document.contents : document.getIn(segments.slice(0, length), true);
    const start = typeof node === 'object' && node !== null && 'range' in node && Array.isArray(node.range) ? node.range[0] : undefined;
    if (typeof start === 'number') {
      const position = lines.linePos(start);
      return { line: position.line, column: position.col };
    }
  }
  return {};
}

function parseFailure(document: Document, file: string): MappingError {
  const issues = [...document.errors, ...document.warnings].map((problem): MappingIssue => {
    const [start] = problem.linePos ?? [];
    return {
      path: '',
      reason: `is not valid YAML (${problem.code})`,
      ...(start === undefined ? {} : { line: start.line, column: start.col }),
    };
  });
  return new MappingError(file, issues);
}

function loadDocument(text: string, file: string): MappingModel {
  const lines = new LineCounter();
  const document = parseDocument(text, { lineCounter: lines, uniqueKeys: true, logLevel: 'silent' });
  if (document.errors.length > 0 || document.warnings.length > 0) throw parseFailure(document, file);

  const unsupported = subsetProblems(document, text, lines);
  if (unsupported.length > 0) throw new MappingError(file, unsupported);

  const { value: data, problems } = decodeYaml(document.toJS({ mapAsMap: true }));
  if (problems.length > 0) {
    throw new MappingError(
      file,
      problems.map((problem): MappingIssue => ({ path: pathOf(problem.segments), reason: problem.reason, ...locate(document, lines, problem.segments) })),
    );
  }

  const parsed = mappingFileSchema.safeParse(data);
  if (!parsed.success) {
    const issues = parsed.error.issues.flatMap((issue) =>
      zodSegments(issue).map((segments): MappingIssue => {
        const context = contextOf(data, segments);
        return { path: pathOf(segments), ...(context === undefined ? {} : { context }), reason: reasonFor(issue, data), ...locate(document, lines, segments) };
      }),
    );
    throw new MappingError(file, issues);
  }

  const built = buildMapping(parsed.data);
  if ('model' in built) return built.model;
  throw new MappingError(
    file,
    built.issues.map((issue): MappingIssue => {
      const context = contextOf(data, issue.segments);
      return { path: pathOf(issue.segments), ...(context === undefined ? {} : { context }), reason: issue.reason, ...locate(document, lines, issue.segments) };
    }),
  );
}

export function parseMapping(text: string, file: string): MappingModel {
  if (Buffer.byteLength(text) > MAX_MAPPING_BYTES) {
    throw new MappingError(file, [{ path: '', reason: `is larger than ${MAX_MAPPING_BYTES} bytes` }]);
  }
  try {
    return loadDocument(text, file);
  } catch (error) {
    if (error instanceof MappingError) throw error;
    // Hostile input makes the YAML parser or the schema throw RangeError or ReferenceError (deep nesting, alias floods); report it as a mapping problem, never as a crash.
    throw new MappingError(file, [{ path: '', reason: 'cannot be processed (nested too deeply, or too many aliases)' }]);
  }
}

function readBounded(path: string): string {
  const descriptor = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_MAPPING_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(descriptor, buffer, length, buffer.length - length, length);
      if (read === 0) break;
      length += read;
    }
    return buffer.toString('utf8', 0, length);
  } finally {
    closeSync(descriptor);
  }
}

export function loadMappingFile(path: string): MappingModel {
  let text: string;
  try {
    text = readBounded(path);
  } catch {
    throw new MappingError(path, [{ path: '', reason: 'cannot be read' }]);
  }
  return parseMapping(text, path);
}
