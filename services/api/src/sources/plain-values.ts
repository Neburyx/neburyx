import neo4j from 'neo4j-driver';
import type { Row } from '../gate/types.js';

/**
 * A value the adapter hands to the gate: JSON-safe, and lossless where JSON has no type. Anything JSON cannot hold carries a `$type` tag; a Neo4j property value is never a map, and a data map
 * a query builds that holds a `$type` key is converted to `unsupported`, so a map with that key cannot reach the gate.
 */
export type PlainValue = null | boolean | number | string | readonly PlainValue[] | { readonly [key: string]: PlainValue };

const tagged = (type: string, fields: Record<string, PlainValue>): PlainValue => ({ $type: type, ...fields });

const UNSUPPORTED = tagged('unsupported', {});

function integer(value: InstanceType<typeof neo4j.Integer>): PlainValue {
  return value.inSafeRange() ? value.toNumber() : tagged('integer', { value: value.toString() });
}

function convertProperties(properties: Record<string, unknown>): PlainValue {
  return Object.fromEntries(Object.entries(properties).map(([key, value]) => [key, plainValue(value)]));
}

function node(value: InstanceType<typeof neo4j.types.Node>): PlainValue {
  return tagged('node', { elementId: value.elementId, labels: [...value.labels], properties: convertProperties(value.properties) });
}

function relationship(value: InstanceType<typeof neo4j.types.Relationship>): PlainValue {
  return tagged('relationship', {
    elementId: value.elementId,
    type: value.type,
    startElementId: value.startNodeElementId,
    endElementId: value.endNodeElementId,
    properties: convertProperties(value.properties),
  });
}

function path(value: InstanceType<typeof neo4j.types.Path>): PlainValue {
  return tagged('path', {
    start: node(value.start),
    segments: value.segments.map((segment) => ({ relationship: relationship(segment.relationship), end: node(segment.end) })),
  });
}

/** Converts one driver value, at every level of a list or map; a value the adapter does not know becomes `unsupported`, never the raw object. */
export function plainValue(value: unknown): PlainValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : tagged('float', { value: String(value) });
  if (typeof value === 'bigint') return tagged('integer', { value: value.toString() });
  if (neo4j.isInt(value)) return integer(value);
  if (neo4j.isDate(value)) return tagged('date', { value: value.toString() });
  if (neo4j.isDateTime(value)) return tagged('dateTime', { value: value.toString() });
  if (neo4j.isLocalDateTime(value)) return tagged('localDateTime', { value: value.toString() });
  if (neo4j.isTime(value)) return tagged('time', { value: value.toString() });
  if (neo4j.isLocalTime(value)) return tagged('localTime', { value: value.toString() });
  if (neo4j.isDuration(value)) return tagged('duration', { value: value.toString() });
  if (neo4j.isPoint(value)) return tagged('point', { srid: integerOrNumber(value.srid), x: value.x, y: value.y, ...(value.z === undefined ? {} : { z: value.z }) });
  if (neo4j.isNode(value)) return node(value);
  if (neo4j.isRelationship(value)) return relationship(value);
  if (neo4j.isPath(value)) return path(value);
  if (Array.isArray(value)) return value.map(plainValue);
  // a data map that holds a `$type` key could pass for a node, a relationship or a path (a query of the operator's own folder can build one), so it is never converted
  if (isPlainObject(value)) return Object.hasOwn(value, '$type') ? UNSUPPORTED : convertProperties(value);
  return UNSUPPORTED;
}

function integerOrNumber(value: unknown): number {
  return neo4j.isInt(value) ? value.toNumber() : typeof value === 'number' ? value : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** A row as the gate sees it: every value converted. */
export function plainRow(row: Record<string, unknown>): Row {
  return convertProperties(row) as Row;
}
