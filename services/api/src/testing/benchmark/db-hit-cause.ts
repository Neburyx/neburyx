import { seriesOf } from '../series.js';

/** What is known about the extra db hits of the first page of the dated read set, for the series it was found on. */
export type DbHitCause =
  | { readonly checked: true; readonly series: string; readonly text: string; readonly affected: readonly string[]; readonly unaffected: readonly string[] }
  | { readonly checked: false; readonly series: string };

/** The release series of the server the cause was found on. */
export const CAUSE_SERIES = '5.26';

export const DB_HIT_CAUSE: DbHitCause = {
  checked: true,
  series: CAUSE_SERIES,
  text: 'The plan the server made the first time it saw the statement after the database was built reads the whole relationship index of the type seven separate times across the four branches of the statement, so the db hits of that plan are 7 x (N + 1) plus the work of the page, N being the relationships of the type in the whole database and not the node\'s. Plans made later for the same statement with another parameter shape expand from the anchor instead and take about 11,000 db hits for the same rows. Which plan a request gets follows when its plan was first made, not whether it has a cursor: asked with a cursor first, the plan with a cursor scans and the one without expands. A plan, once made, is kept for the run. In a small database the later plan scans as well.',
  affected: ['the db hits and server times of the position whose plan was made first after the database was built: in this record the first position of the dated read set, at every size'],
  unaffected: ['the db hits of the 10 %, 50 % and 90 % positions of the dated read set', 'the other read sets show no extra db hits at their first position in this record; their plans were not examined'],
};

/** The cause as it applies to a run on a server of `version`: the one found, on its own series; on any other, that it was not checked there. */
export function dbHitCauseFor(version: string): DbHitCause {
  const series = seriesOf(version);
  return series === CAUSE_SERIES ? DB_HIT_CAUSE : { checked: false, series: series ?? version };
}
