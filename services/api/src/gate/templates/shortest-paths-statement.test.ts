import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors.js';
import { linkedMappingOf } from '../../testing/linked-entities-fixtures.js';
import { PATHS_ENTITIES } from '../../testing/paths-fixtures.js';
import { allowlistFromMapping } from '../allowlist.js';
import { pathsRequestOf, shortestPathsCountStatementOf, shortestPathsStatementOf } from './shortest-paths-statement.js';

const [source] = linkedMappingOf({ entities: PATHS_ENTITIES }).sources;
if (source === undefined) throw new Error('the mapping has no source');
const allowlist = allowlistFromMapping(source);
const ends = (from = 'A-1', to = 'Z-1') => [
  { sourceId: 'demo', entityType: 'maker', stableId: from, stableInteger: undefined },
  { sourceId: 'demo', entityType: 'maker', stableId: to, stableInteger: undefined },
];
const params = (more: Record<string, unknown> = {}) => ({ ends: ends(), via: ['LINKS'], maxHops: 3, ...more });
const refused = (more: Record<string, unknown>) => () => pathsRequestOf(allowlist, params(more));

describe('the statement of the shortest-paths template', () => {
  it('is written from the mapping: both ends by stable ID, the optional second end, the paths bounded by the hop count and the limit', () => {
    expect(shortestPathsStatementOf(allowlist, pathsRequestOf(allowlist, params()))).toBe(
      [
        'MATCH (a:`Maker`) USING INDEX SEEK a:`Maker`(`makerId`) WHERE a.`makerId` IN [$ends[0].stableId, $ends[0].stableInteger] WITH a ORDER BY elementId(a) LIMIT 1',
        'OPTIONAL MATCH (b:`Maker`) USING INDEX SEEK b:`Maker`(`makerId`) WHERE b.`makerId` IN [$ends[1].stableId, $ends[1].stableInteger] WITH a, b ORDER BY elementId(b) LIMIT 1',
        'OPTIONAL MATCH p = allShortestPaths((a)-[:`LINKS`*1..3]-(b))',
        'RETURN a, b, p LIMIT $limit + 1',
      ].join('\n'),
    );
  });

  it('walks along the stored direction for out, against it for in and either way for both or none', () => {
    const walk = (direction?: string) => shortestPathsStatementOf(allowlist, pathsRequestOf(allowlist, params(direction === undefined ? {} : { direction })));
    expect(walk('out')).toContain('(a)-[:`LINKS`*1..3]->(b)');
    expect(walk('in')).toContain('(a)<-[:`LINKS`*1..3]-(b)');
    expect(walk('both')).toContain('(a)-[:`LINKS`*1..3]-(b)');
    expect(walk()).toContain('(a)-[:`LINKS`*1..3]-(b)');
  });

  it('refuses a direction that is not out, in or both', () => {
    expect(refused({ direction: 'sideways' })).toThrow(AppError);
  });

  it('joins the listed relationship types and takes the hop count from the request', () => {
    const statement = shortestPathsStatementOf(allowlist, pathsRequestOf(allowlist, params({ via: ['LINKS', 'USES_TOOL'], maxHops: 1 })));
    expect(statement).toContain('[:`LINKS`|`USES_TOOL`*1..1]');
  });

  it('refuses a relationship type the mapping does not have, a repeated one and none', () => {
    for (const via of [['NOPE'], ['LINKS', 'LINKS'], []]) expect(refused({ via })).toThrow(AppError);
  });

  it('refuses a hop count that is not a whole number from 1 to the ceiling', () => {
    for (const maxHops of [0, 5, 1.5, '2']) expect(refused({ maxHops })).toThrow(AppError);
  });

  it('refuses two ends that are one entity and an entity type with no label', () => {
    expect(refused({ ends: ends('A-1', 'A-1') })).toThrow(AppError);
    const [first, second] = ends();
    const unknown = pathsRequestOf(allowlist, params({ ends: [first, { ...second, entityType: 'nope' }] }));
    expect(() => shortestPathsStatementOf(allowlist, unknown)).toThrow(AppError);
  });

  it('never holds a value of the request in its text', () => {
    const statement = shortestPathsStatementOf(allowlist, pathsRequestOf(allowlist, params({ ends: ends("A-1'; DROP", 'Z-1') })));
    expect(statement).not.toContain('DROP');
    expect(statement).not.toContain('A-1');
  });
});

describe('the statement of the probe of the shortest-paths template', () => {
  const count = (more: Record<string, unknown> = {}) => shortestPathsCountStatementOf(allowlist, pathsRequestOf(allowlist, params(more)));

  it('counts the relationships at each end in the direction the search expands, each up to the count cap plus one', () => {
    expect(count()).toBe(
      [
        'MATCH (a:`Maker`) USING INDEX SEEK a:`Maker`(`makerId`) WHERE a.`makerId` IN [$ends[0].stableId, $ends[0].stableInteger] WITH a ORDER BY elementId(a) LIMIT 1',
        'OPTIONAL MATCH (b:`Maker`) USING INDEX SEEK b:`Maker`(`makerId`) WHERE b.`makerId` IN [$ends[1].stableId, $ends[1].stableInteger] WITH a, b ORDER BY elementId(b) LIMIT 1',
        'CALL { WITH a OPTIONAL MATCH (a)-[r:`LINKS`]-() WITH r LIMIT $countCap + 1 RETURN count(r) AS fromDegree }',
        'CALL { WITH b OPTIONAL MATCH (b)-[r:`LINKS`]-() WITH r LIMIT $countCap + 1 RETURN count(r) AS toDegree }',
        'RETURN b IS NOT NULL AS toFound, fromDegree, toDegree',
      ].join('\n'),
    );
  });

  it('leaves the first end along the stored direction and arrives at the second for out, and the reverse for in', () => {
    expect(count({ direction: 'out' })).toContain('(a)-[r:`LINKS`]->()');
    expect(count({ direction: 'out' })).toContain('(b)<-[r:`LINKS`]-()');
    expect(count({ direction: 'in' })).toContain('(a)<-[r:`LINKS`]-()');
    expect(count({ direction: 'in' })).toContain('(b)-[r:`LINKS`]->()');
  });
});
