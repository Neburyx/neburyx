import type { ExportHeader, GraphEdge, GraphNode, GraphProperty } from '@neburyx/contracts';
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
