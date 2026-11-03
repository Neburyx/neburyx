/** When a relationship was observed, as the source gave it: a zoned `dateTime` compares as an instant, a `localDateTime` or a `date` as a local time with no zone. */
interface Moment {
  readonly zoned: boolean;
  readonly key: bigint | string;
  readonly text: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const ZONED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})(?:\[[^\]]*\])?$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?)?$/;

/** The moment a plain value stands for, or nothing when it is not a date, a dateTime or a localDateTime, or its text is not one the product can read. */
export function momentOf(value: unknown): Moment | undefined {
  if (!isObject(value) || typeof value['value'] !== 'string') return undefined;
  const text = value['value'];
  if (value['$type'] === 'dateTime') {
    const match = ZONED.exec(text);
    if (match === null) return undefined;
    const [, base, fraction = '', offset] = match;
    const milliseconds = Date.parse(`${base ?? ''}.000${offset ?? ''}`);
    if (Number.isNaN(milliseconds)) return undefined;
    return { zoned: true, key: BigInt(milliseconds) * 1_000_000n + BigInt(fraction.padEnd(9, '0')), text };
  }
  if (value['$type'] === 'localDateTime' || value['$type'] === 'date') {
    const match = LOCAL.exec(text);
    if (match === null) return undefined;
    const [, day, time = '00:00:00', fraction = ''] = match;
    return { zoned: false, key: `${day ?? ''}T${time}.${fraction.padEnd(9, '0')}`, text };
  }
  return undefined;
}

const earlier = (left: Moment, right: Moment): boolean => left.key < right.key;

/**
 * The earliest and latest of the members' times, each written as the member gave it (no zone is added). Zoned and local times are not comparable with each other: a mix
 * uses the zoned ones and says so. Times the product cannot read are ignored; with none left, there are no first and last.
 */
export function firstAndLast(values: readonly unknown[]): { readonly first?: string; readonly last?: string; readonly mixed: boolean } {
  const moments = values.flatMap((value) => momentOf(value) ?? []);
  const zoned = moments.filter((moment) => moment.zoned);
  const local = moments.filter((moment) => !moment.zoned);
  const mixed = zoned.length > 0 && local.length > 0;
  const chosen = zoned.length > 0 ? zoned : local;
  const [head, ...rest] = chosen;
  if (head === undefined) return { mixed };
  let first = head;
  let last = head;
  for (const moment of rest) {
    if (earlier(moment, first)) first = moment;
    if (earlier(last, moment)) last = moment;
  }
  return { first: first.text, last: last.text, mixed };
}
