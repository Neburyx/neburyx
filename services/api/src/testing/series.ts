/** The release series the Neo4j tests accept: the last 5.x LTS and the 2026 calendar releases. */
export const ACCEPTED_SERIES: readonly string[] = ['5.26', '2026'];

/** The series of a server version, or undefined when the tests do not accept it. */
export function seriesOf(version: string): string | undefined {
  return ACCEPTED_SERIES.find((series) => version.startsWith(`${series}.`));
}

/** The series of the server, or an error that names the series it saw and the ones the tests accept. */
export function checkSeries(version: string): string {
  const series = seriesOf(version);
  if (series !== undefined) return series;
  const seen = version === '' ? 'no version' : version.split('.').slice(0, 2).join('.');
  throw new Error(`the tests are written for Neo4j ${ACCEPTED_SERIES.join(' and ')}; the server runs ${seen}`);
}

/** Hands the series of the server to the test files of a run (they read it with `inject`), or stops the run with the message of `checkSeries`. */
export function provideSeries(version: string, provide: (key: 'neo4jSeries', value: string) => void): string {
  const series = checkSeries(version);
  provide('neo4jSeries', series);
  return series;
}
