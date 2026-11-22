import { momentKey } from '../../mapping/moment-key.js';

/** When a relationship was observed, as the source gave it: a zoned `dateTime` compares as an instant, a `localDateTime` or a `date` as a local time with no zone. */
interface Moment {
  readonly zoned: boolean;
  readonly key: bigint | string;
  readonly text: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The moment a plain value stands for, or nothing when it is not a date, a dateTime or a localDateTime, or its text is not one the product can read. */
function momentOf(value: unknown): Moment | undefined {
  if (!isObject(value) || typeof value['value'] !== 'string') return undefined;
  const text = value['value'];
  const tag = value['$type'];
  if (tag !== 'dateTime' && tag !== 'localDateTime' && tag !== 'date') return undefined;
  const key = momentKey(tag, text);
  return key === undefined ? undefined : { zoned: tag === 'dateTime', key, text };
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
