import type { FilterKind } from '@neburyx/contracts';

const ZONED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})(?:\[[^\]]*\])?$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?)?$/;
const ZONED_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;
const LOCAL_TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?$/;

const offsetSeconds = (offset: string): number => {
  if (offset === 'Z') return 0;
  const sign = offset.startsWith('-') ? -1 : 1;
  return sign * (Number(offset.slice(1, 3)) * 3600 + Number(offset.slice(4, 6)) * 60);
};

/**
 * A moment as an ordered key, and the one reader of the product's temporal text: the observed time of a relationship (`firstAndLast`) and the values a style rule compares use it, so a fix reaches both.
 * It is an instant in nanoseconds for a zoned value, a fixed-width text for a local one; nothing when the text is not one the product can read. */
export function momentKey(valueClass: FilterKind, text: string): bigint | string | undefined {
  if (valueClass === 'dateTime') {
    const match = ZONED.exec(text);
    if (match === null) return undefined;
    const [, base = '', fraction = '', offset = 'Z'] = match;
    const milliseconds = Date.parse(`${base}.000${offset}`);
    return Number.isNaN(milliseconds) ? undefined : BigInt(milliseconds) * 1_000_000n + BigInt(fraction.padEnd(9, '0'));
  }
  if (valueClass === 'date' || valueClass === 'localDateTime') {
    const match = LOCAL.exec(text);
    if (match === null) return undefined;
    const [, day = '', time = '00:00:00', fraction = ''] = match;
    return `${day}T${time}.${fraction.padEnd(9, '0')}`;
  }
  if (valueClass === 'time') {
    const match = ZONED_TIME.exec(text);
    if (match === null) return undefined;
    const [, hours = '0', minutes = '0', seconds = '0', fraction = '', offset = 'Z'] = match;
    const whole = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) - offsetSeconds(offset);
    return BigInt(whole) * 1_000_000_000n + BigInt(fraction.padEnd(9, '0'));
  }
  if (valueClass === 'localTime') {
    const match = LOCAL_TIME.exec(text);
    if (match === null) return undefined;
    const [, hours = '', minutes = '', seconds = '00', fraction = ''] = match;
    return `${hours}:${minutes}:${seconds}.${fraction.padEnd(9, '0')}`;
  }
  return undefined;
}
