import type { ExportHeader, ExportSummary, GraphEdge, GraphNode, GraphProperty } from '@neburyx/contracts';
import { compareEdges, compareNodes } from './json-file.js';

const BYTE_ORDER_MARK = '﻿';
const LINE_END = '\r\n';
/** A cell that starts with one of these runs as a formula in a spreadsheet tool: the ASCII four and their full-width forms. */
const FORMULA_START = /^\s*[=+\-@＝＋－＠]/u;
const CONTROL_START = /^[\t\r\n]/;

export type Cell = string | number | null;

/** A text cell a spreadsheet could read as a formula gets a leading apostrophe, which the tool shows as plain text. */
export function guardedText(text: string): string {
  return CONTROL_START.test(text) || FORMULA_START.test(text) ? `'${text}` : text;
}

/** Text is always quoted (RFC 4180, quotes doubled) and guarded; a number Neburyx writes is not text and is written as it is; no value is an empty cell. */
export function csvCell(cell: Cell): string {
  if (cell === null) return '';
  if (typeof cell === 'number') return String(cell);
  return `"${guardedText(cell).replace(/"/g, '""')}"`;
}

const row = (cells: readonly Cell[]): string => cells.map(csvCell).join(',');

function plainText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? '';
}

const keysOf = (items: readonly { readonly properties: readonly GraphProperty[] }[]): string[] => [...new Set(items.flatMap((item) => item.properties.map((property) => property.key)))].sort();

function propertyCells(properties: readonly GraphProperty[], keys: readonly string[]): Cell[] {
  return keys.map((key) => {
    const found = properties.find((property) => property.key === key);
    return found === undefined ? null : plainText(found.value);
  });
}

function headerLines(header: ExportHeader): string[] {
  return header.lines.map((line) => csvCell(`# ${line}`));
}

function fileOf(header: ExportHeader, columns: readonly string[], rows: readonly (readonly Cell[])[]): Buffer {
  const lines = [...headerLines(header), row(columns), ...rows.map(row)];
  return Buffer.from(`${BYTE_ORDER_MARK}${lines.join(LINE_END)}${LINE_END}`, 'utf8');
}

export function entitiesCsvOf(header: ExportHeader, nodes: readonly GraphNode[]): Buffer {
  const sorted = [...nodes].sort(compareNodes);
  const keys = keysOf(sorted);
  return fileOf(header, ['type', 'id', 'title', ...keys], sorted.map((node) => [node.ref.entityType, node.ref.stableId, node.display.title, ...propertyCells(node.properties, keys)]));
}

function kindOf(edge: GraphEdge): 'stored' | 'aggregate' | 'derived' {
  if ('aggregate' in edge.ref) return 'aggregate';
  return edge.semantics === 'derived' ? 'derived' : 'stored';
}

const MEMBER_COUNT_COLUMNS = ['member_count', 'member_count_quality'] as const;

export function relationshipsCsvOf(header: ExportHeader, edges: readonly GraphEdge[]): Buffer {
  const sorted = [...edges].sort(compareEdges);
  const keys = keysOf(sorted);
  const columns = ['type', 'id', 'from_type', 'from_id', 'to_type', 'to_id', 'kind', ...MEMBER_COUNT_COLUMNS, ...keys];
  return fileOf(
    header,
    columns,
    sorted.map((edge) => [
      edge.type,
      'stableId' in edge.ref ? edge.ref.stableId : '',
      edge.from.entityType,
      edge.from.stableId,
      edge.to.entityType,
      edge.to.stableId,
      kindOf(edge),
      edge.memberCount?.value ?? null,
      edge.memberCount?.quality ?? '',
      ...propertyCells(edge.properties, keys),
    ]),
  );
}

/** A part of a cite as text: the three characters that separate parts and cites are written as percent codes, so an id that holds one is never read as a separator. */
const citePart = (part: string): string => part.replace(/[%:;]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`);

const citeRowOf = (kind: string, ...parts: readonly string[]): string => [kind, ...parts.map(citePart)].join(':');

/**
 * How a cite is written in `summary.csv`: the kind, then the same columns the cited row has in its own file, so it resolves to exactly one row: `entity:<type>:<id>` in entities.csv, `relationship:<type>:<id>` for a stored relationship,
 * and `aggregate` or `derived` with `<type>:<from type>:<from id>:<to type>:<to id>` for the others, whose rows have no id.
 */
function citeTextOf(cite: ExportSummary['sentences'][number]['cites'][number], edges: readonly GraphEdge[]): string {
  if (cite.kind === 'entity') return citeRowOf('entity', cite.ref.entityType, cite.ref.stableId);
  const wanted = JSON.stringify(cite.ref);
  const edge = edges.find((candidate) => JSON.stringify(candidate.ref) === wanted);
  if (edge === undefined) return citeRowOf('relationship', '', '');
  const kind = kindOf(edge);
  return kind === 'stored' && 'stableId' in edge.ref ? citeRowOf('relationship', edge.type, edge.ref.stableId) : citeRowOf(kind, edge.type, edge.from.entityType, edge.from.stableId, edge.to.entityType, edge.to.stableId);
}

/** The third file of a CSV export that includes the summary: its header lines say what the file is, then one row for each sentence, every cell guarded as in the other files. */
export function summaryCsvOf(header: ExportHeader, summary: ExportSummary, edges: readonly GraphEdge[]): Buffer {
  const own: ExportHeader = { ...header, lines: [...header.lines, summary.label, `model: ${summary.model}`, `drafted: ${summary.generatedAt}`, `coverage: ${summary.coverage.retrieval}`, `coverage: ${summary.coverage.summary}`] };
  return fileOf(own, ['sentence', 'cites'], summary.sentences.map((sentence) => [sentence.text, sentence.cites.map((cite) => citeTextOf(cite, edges)).join(';')]));
}

