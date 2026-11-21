import { predicateRead } from './predicate-read.js';
/**
 * The observed time of a relationship as an instant: a zoned date time as it is, a local date time and a date read as UTC. A value of any other kind (text, a number, nothing) is no instant, so it is not in any window.
 * `time` is the quoted property name from the mapping.
 */
export const instantOf = (variable: string, time: string): string => {
  const read = predicateRead(`${variable}.${time}`);
  return `CASE WHEN ${read} IS :: ZONED DATETIME THEN ${read} WHEN ${read} IS :: LOCAL DATETIME THEN datetime({datetime: ${read}, timezone: 'UTC'}) WHEN ${read} IS :: DATE THEN datetime({date: ${read}, timezone: 'UTC'}) END`;
};

/** The two conditions that keep a relationship whose observed time is from the first bound up to but not including the second (`$windowFrom` and `$windowTo` unless a template reads them from another parameter); both bounds are parameters. */
export const inWindow = (variable: string, time: string, from = '$windowFrom', to = '$windowTo'): readonly string[] => [`${instantOf(variable, time)} >= datetime(${from})`, `${instantOf(variable, time)} < datetime(${to})`];
