import { describe, expect, it } from 'vitest';
import { baseSource, expectRefused, fileOf, issuesOf, load } from '../testing/mapping.js';
import { PACKS, packMappingText } from '../testing/pack-fixtures.js';
import { parseMapping } from './load.js';
import { RESERVED_SOURCE_IDS } from './reserved-source-ids.js';

describe('the ID of a source', () => {
  it.each(RESERVED_SOURCE_IDS)('is refused when it is %s, with a message that names the key and says why', (id) => {
    const issue = expectRefused(baseSource({ id }), 'sources[0].id', 'could not reach the app');
    expect(issue.reason).toContain('first segment of the paths the API answers');
    expect(issue.reason).not.toContain(`"${id}"`);
  });

  it('is refused whichever source of the file has it', () => {
    const issues = issuesOf(fileOf(baseSource({ id: 'fine' }), baseSource({ id: 'v1', uri: 'neo4j+s://other.example.test:7687' })));
    expect(issues.some((issue) => issue.path === 'sources[1].id')).toBe(true);
    expect(issues.some((issue) => issue.path === 'sources[0].id')).toBe(false);
  });

  it.each(['v10', 'v1-other', 'V1', 'v1.a', 'xv1', 'v', 'healthz', 'readyz', 'assets', 'index.html', 'explore', 'investigations', 'sources', 'dev'])('is accepted when it is %s, since a deep link to it reaches the app', (id) => {
    expect(load(baseSource({ id })).sources[0]?.id).toBe(id);
  });

  it.each(PACKS)('of the %s pack is accepted', (pack) => {
    const [source] = parseMapping(packMappingText(pack), 'neburyx.yaml').sources;
    expect(source?.id).toBeDefined();
    expect(RESERVED_SOURCE_IDS).not.toContain(source?.id);
  });
});
