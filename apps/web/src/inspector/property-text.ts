import type { GraphProperty } from '@neburyx/contracts';
import { formatUtc } from '../sources/health-facts.js';
import { NO_ZONE, UNAVAILABLE } from './copy.js';

const ZONE_NAME = /\[[^\]]*\]$/;
const LOCAL_CLASSES: ReadonlySet<string> = new Set(['localDateTime', 'localTime']);

function plain(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

/**
 * The text a property is shown and copied as. Only a `dateTime` that is not masked is turned into UTC with seconds: a date has no time, a local value has no zone, and a mask is never read as a value.
 */
export function propertyText(property: GraphProperty): string {
  if (property.value === undefined || property.value === null) return UNAVAILABLE;
  const text = plain(property.value);
  if (property.masked) return text;
  if (property.dataClass === 'dateTime' && typeof property.value === 'string') {
    // the offset is already in the text; a named zone after it is dropped, since Date does not read it
    const instant = property.value.replace(ZONE_NAME, '');
    if (!Number.isNaN(Date.parse(instant))) return formatUtc(instant);
  }
  if (LOCAL_CLASSES.has(property.dataClass)) return `${text} ${NO_ZONE}`;
  return text;
}
