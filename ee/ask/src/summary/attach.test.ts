import type { AskRunResult, AskSummary } from '@neburyx/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { anchorOfParams, summaryOfRun } from './attach.js';
import { summarize, type SummaryOutcome } from './index.js';

vi.mock('./index.js', () => ({ summarize: vi.fn() }));

const run = { templateId: 'entity', result: {} } as unknown as AskRunResult;
const ref = { sourceId: 'demo', entityType: 'node_a', stableId: 'a-1' };
const good: AskSummary = { sentences: [{ text: 'A is of type node_a.', cites: ['n1'] }], citations: [{ key: 'n1', element: ref, type: 'node_a', title: 'A' }] };
const plan = { sourceId: 'demo', params: { ref: { entityType: 'node_a', stableId: 'a-1' } } };
const warnings: Record<string, unknown>[] = [];
const logger = { warn: (fields: Record<string, unknown>) => void warnings.push(fields) };
const outcome = (value: SummaryOutcome) => vi.mocked(summarize).mockReturnValue(value);

beforeEach(() => {
  warnings.length = 0;
});

describe('the summary a run answer carries', () => {
  it('is the summary the builders made, and nothing when they made none', () => {
    outcome({ kind: 'summary', summary: good });
    expect(summaryOfRun(run, plan, logger)).toEqual(good);
    outcome({ kind: 'none' });
    expect(summaryOfRun(run, plan, logger)).toBeUndefined();
    expect(warnings).toEqual([]);
  });

  it('is dropped with the code check-failed when the summary fails its own check', () => {
    outcome({ kind: 'check-failed' });
    expect(summaryOfRun(run, plan, logger)).toBeUndefined();
    expect(warnings).toEqual([{ event: 'ask-summary-dropped', code: 'check-failed' }]);
  });

  it('is dropped with the code schema when it does not fit the contract, and other-source when it cites another source', () => {
    outcome({ kind: 'summary', summary: { ...good, citations: [...good.citations, ...good.citations] } });
    expect(summaryOfRun(run, plan, logger)).toBeUndefined();
    outcome({ kind: 'summary', summary: good });
    expect(summaryOfRun(run, { ...plan, sourceId: 'other' }, logger)).toBeUndefined();
    expect(warnings.map((fields) => fields.code)).toEqual(['schema', 'other-source']);
  });

  it('is dropped with the code builder-threw when the builder throws, and a logger that throws changes nothing', () => {
    vi.mocked(summarize).mockImplementation(() => {
      throw new Error('boom');
    });
    expect(summaryOfRun(run, plan, { warn: () => { throw new Error('logger'); } })).toBeUndefined();
    expect(summaryOfRun(run, plan, logger)).toBeUndefined();
    expect(warnings).toEqual([{ event: 'ask-summary-dropped', code: 'builder-threw' }]);
  });
});

describe('the anchor of a plan', () => {
  it('is the plan’s source with the entity type and stable ID its parameters name, and none when they name none', () => {
    expect(anchorOfParams('demo', plan.params)).toEqual(ref);
    expect(anchorOfParams('demo', { ref: { entityType: '', stableId: 'a' } })).toBeUndefined();
    expect(anchorOfParams('demo', { other: 1 })).toBeUndefined();
    expect(anchorOfParams('demo', null)).toBeUndefined();
  });
});
