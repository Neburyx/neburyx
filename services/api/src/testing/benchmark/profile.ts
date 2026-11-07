import neo4j, { type ProfiledPlan } from 'neo4j-driver';
import type { CursorPosition } from '../../gate/cursor/codec.js';
import { allowlistFromMapping } from '../../gate/allowlist.js';
import { defaultCatalog } from '../../gate/assemble.js';
import { renderTemplate } from '../../gate/render.js';
import { EXPAND_NEIGHBORS_ID } from '../../gate/templates/expand-neighbors.js';
import { sourceFor, type RunningNeo4j } from '../neo4j-server.js';
import { ENTITIES, hubOf, RELATIONSHIPS } from './fixture.js';
import { PAGE, RELATIONSHIP_OF, type ReadSet } from './plan.js';

const ANCHOR_LABEL = ENTITIES[0]?.label ?? '';

/** What the server does for the page at one position of a read set, from the plan it ran. */
export interface Profile {
  readonly size: number;
  readonly readSet: ReadSet;
  readonly position: string;
  /** The `UNION ALL` branches the gate rendered; each matches the relationships of its type on the anchor. */
  readonly branches: number;
  readonly dbHits: number;
  readonly rootRows: number;
  /** The server's own time for the statement, in milliseconds: until the first record was available, and from then until the last was consumed (the two add up to the total). */
  readonly availableMs: number;
  readonly consumedMs: number;
  readonly indexSeek: boolean;
}

const operators = (plan: ProfiledPlan | false): readonly ProfiledPlan[] => (plan === false ? [] : [plan, ...plan.children.flatMap(operators)]);
const numberOf = (value: unknown): number => (neo4j.isInt(value) ? value.toNumber() : Number(value ?? 0));

/** Runs the statement the gate renders for the page at a position (the position its cursor held when the gate minted it, or none for the first page) under PROFILE, on the run's own session and database, and fails when the anchor is not read by an index seek or the root returns more than a page and one row: a slow figure must not come from a missing index or an unbounded read. */
export async function profileReadSet(server: RunningNeo4j, size: number, readSet: ReadSet, position: string, cursor: CursorPosition | undefined): Promise<Profile> {
  const template = defaultCatalog().find(EXPAND_NEIGHBORS_ID);
  if (template === undefined) throw new Error('the expand template is not in the catalog');
  const allowlist = allowlistFromMapping(sourceFor(server, { entities: ENTITIES, relationships: RELATIONSHIPS }));
  const relTypes = readSet === 'all' ? {} : { relTypes: [RELATIONSHIP_OF[readSet]] };
  const rendered = renderTemplate(template, { entityType: 'hub', stableId: hubOf(size), stableInteger: null, neighborType: 'leaf', direction: 'both', sort: 'observed', ...relTypes }, allowlist, PAGE, 500);
  const session = server.admin.session({ database: server.database });
  try {
    const result = await session.run(`PROFILE ${rendered.cypher}`, { ...rendered.parameters, limit: neo4j.int(PAGE), cursor: cursor ?? null });
    const all = operators(result.summary.profile);
    const indexSeek = all.some((operator) => /IndexSeek/.test(operator.operatorType) && String(operator.arguments['Details'] ?? '').includes(`:${ANCHOR_LABEL}(`));
    if (!indexSeek) throw new Error(`the plan of ${readSet} at ${size}, ${position} does not read the anchor by a seek of its stable ID index`);
    const rootRows = numberOf(all[0]?.arguments['Rows']);
    if (rootRows > PAGE + 1) throw new Error(`the plan of ${readSet} at ${size}, ${position} returns ${rootRows} rows from its root, more than a page and one`);
    const { resultAvailableAfter, resultConsumedAfter } = result.summary;
    return { size, readSet, position, branches: rendered.cypher.split(' UNION ALL ').length, dbHits: all.reduce((sum, operator) => sum + operator.dbHits, 0), rootRows, availableMs: numberOf(resultAvailableAfter), consumedMs: numberOf(resultConsumedAfter), indexSeek };
  } finally {
    await session.close();
  }
}
