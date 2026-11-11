// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { RequestState } from '../api/use-request.js';
import { listOf } from '../investigations/test-data.js';
import { source } from '../test-utils.js';
import type { SourcesResponse } from '@neburyx/contracts';
import { FIRST_RUN_COPY } from './copy.js';
import { demoCaseLabel, type DemoCaseEntry } from './demo-case.js';
import { decideStart } from './start-decision.js';

const root = (path: string): string => readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8');
const readme = root('README.md').replace(/\s+/g, ' ');
const sourceId = (pack: string): string => /^ {2}- id: (\S+)/m.exec(root(`domain-packs/${pack}/neburyx.yaml`))?.[1] ?? '';
const entry = (id: string): DemoCaseEntry => ({ sourceId: id, alias: id, entityType: 'x', stableId: 'x', caseRef: 'x' });

describe('the first page the README describes', () => {
  const ids = ['banking-fraud', 'insurance-claims'].map(sourceId);

  it('quotes the title, the tag, the empty state and one demo button for each demo graph, as the web app writes them', () => {
    expect(ids).toEqual(['banking-demo', 'insurance-demo']);
    const labels = ids.map((id) => demoCaseLabel(FIRST_RUN_COPY.openDemoCase, entry(id), ids.length));
    expect(labels).toEqual(['Open demo case · banking-demo', 'Open demo case · insurance-demo']);
    for (const phrase of [FIRST_RUN_COPY.title, FIRST_RUN_COPY.tag, FIRST_RUN_COPY.emptyTitle, ...labels]) expect(readme).toContain(`"${phrase}"`);
  });

  it('is what opens on a fresh demo stack: two synthetic demo sources and no investigation', () => {
    const sources: RequestState<SourcesResponse> = { phase: 'ready', data: { items: ['banking-demo', 'insurance-demo'].map((id) => source(id, { synthetic: true, state: 'connected' })), nextCursor: null } };
    const list: RequestState<ReturnType<typeof listOf>> = { phase: 'ready', data: { ...listOf([]), counts: { ...listOf([]).counts, investigations: { value: 0, quality: 'exact', scope: 'investigations' } } } };
    expect(decideStart({ sources, list, asked: true, settledCount: 0 })).toBe('first-run');
  });
});

describe('the alias of a source', () => {
  it('is its id, because the product stores the id as the alias', () => {
    expect(root('services/api/src/db/sources-repository.ts')).toContain('VALUES ($1, $1,');
  });
});
