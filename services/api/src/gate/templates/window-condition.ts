/**
 * The observed time of a relationship as an instant: a zoned date time as it is, a local date time and a date read as UTC. A value of any other kind (text, a number, nothing) is no instant, so it is not in any window.
 * `time` is the quoted property name from the mapping.
 */
export const instantOf = (variable: string, time: string): string =>
  `CASE WHEN ${variable}.${time} IS :: ZONED DATETIME THEN ${variable}.${time} WHEN ${variable}.${time} IS :: LOCAL DATETIME THEN datetime({datetime: ${variable}.${time}, timezone: 'UTC'}) WHEN ${variable}.${time} IS :: DATE THEN datetime({date: ${variable}.${time}, timezone: 'UTC'}) END`;

/** The two conditions that keep a relationship whose observed time is from `$windowFrom` up to but not including `$windowTo`; both bounds are parameters. */
export const inWindow = (variable: string, time: string): readonly string[] => [`${instantOf(variable, time)} >= datetime($windowFrom)`, `${instantOf(variable, time)} < datetime($windowTo)`];
