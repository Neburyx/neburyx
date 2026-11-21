import type { ExtensionRequest, SummarySentence } from '@neburyx/contracts';
import { buildSummaryInstructions, createAuditedModelCall, promptRecordOf, type ModelProvider, type ModelRequest } from '@neburyx/ee-ask';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { caseOf, loadCases } from './cases.js';
import { defined } from './checks.js';
import { NUMBER_ON_THE_SECOND } from './evidence.js';
import { mutatedChecks, type Mutation } from './mutants.js';
import { viewOf, type Evidence } from './rules.js';

const set = loadCases();
const labelled = caseOf(set, 0);

afterEach(() => {
  vi.doUnmock('../../../ee/ask/src/case-summary/checks.js');
  vi.resetModules();
});

/** The overview beside a verdict refusal, drafted by the product's own view path and checks over one labelled view, with the model scripted to give `sentences`; the plain refusal has no `overview` member. */
async function refusalWith(mutation: Mutation | undefined, sentences: readonly SummarySentence[], evidence: Evidence, connectionsOnly?: boolean) {
  vi.resetModules();
  if (mutation !== undefined) {
    const mutant = await mutatedChecks(mutation);
    vi.doMock('../../../ee/ask/src/case-summary/checks.js', () => mutant);
  }
  const { createViewAnswer } = await import('../../../ee/ask/src/assistant/view-answer.js');
  const { verdictRefusal, OVERVIEW_PROMPT_ID, OVERVIEW_PROMPT_VERSION, OVERVIEW_AUDIT_ACTION } = await import('../../../ee/ask/src/assistant/verdict-overview.js');
  const { createCheckRunner } = await import('../../../ee/ai-runtime/src/index.js');
  const requests: ModelRequest[] = [];
  const provider: ModelProvider = {
    complete: async (request) => {
      requests.push(request);
      return { status: 'ok', text: JSON.stringify({ sentences }), usage: { kind: 'known', inputTokens: 100, outputTokens: 20 }, model: 'claude-sonnet-5-5', prompt: promptRecordOf(request) };
    },
  };
  const model = createAuditedModelCall({ provider, configuration: { model: 'claude-sonnet-5-5' }, sink: { record: async () => undefined } });
  const overview = createViewAnswer({
    model,
    prompt: { id: OVERVIEW_PROMPT_ID, version: OVERVIEW_PROMPT_VERSION, action: OVERVIEW_AUDIT_ACTION, connectionsOnly: connectionsOnly ?? true },
    instructions: () => buildSummaryInstructions('OVERVIEW PROMPT', ''),
    checks: createCheckRunner(),
    settings: () => ({ model: 'claude-sonnet-5-5', maxInputTokens: 25_000, maxCalls: 5, timeoutMs: 10_000, totalTimeoutMs: 180_000 }),
  });
  const reading = evidence.view;
  const refs = reading.nodes.map((node) => node.ref);
  const sourceId = defined(refs[0], 'a node').sourceId;
  const answer = await verdictRefusal({
    overview,
    request: { principalRole: 'investigator', principalId: 'analyst-1', traceId: 'trace-1', signal: new AbortController().signal } as unknown as ExtensionRequest,
    body: { sourceId, investigationId: 'inv-1', mask: false, viewElementKeys: refs.map((ref) => JSON.stringify(['node', ref.sourceId, ref.entityType, ref.stableId])) },
    readElements: (async () => reading) as unknown as ExtensionRequest['readElements'],
    deadline: new AbortController().signal,
    startedAt: Date.now(),
    callsUsed: 1,
  });
  expect(evidence.first).toBeDefined();
  return { answer, requests };
}

const shown = (answer: Awaited<ReturnType<typeof refusalWith>>['answer']): readonly string[] => (answer.status === 'answered' && answer.route === 'refuse' && answer.overview !== undefined ? answer.overview.sentences.map((sentence) => sentence.text) : []);

describe('the overview beside a refusal of a verdict, over a labelled view, with the product’s own checks', () => {
  it('is rejected, as the plain refusal, when the draft holds verdict wording, and is shown when it does not', async () => {
    const evidence = await viewOf(labelled);
    const good: SummarySentence = { text: 'There were ~40 (estimated) transfers.', cites: [evidence.estimated] };
    const worded: SummarySentence = { text: 'This is evidence of fraud.', cites: [evidence.estimated] };
    expect(shown((await refusalWith(undefined, [good], evidence)).answer)).toEqual(['There were ~40 (estimated) transfers.']);
    const rejected = await refusalWith(undefined, [good, worded], evidence);
    expect(shown(rejected.answer)).toEqual([]);
    expect(rejected.answer).toEqual({ status: 'answered', route: 'refuse', cause: 'verdict', sentence: expect.any(String) });
  });

  it('drops a sentence that cites nothing and keeps the cited one beside it', async () => {
    const evidence = await viewOf(labelled);
    const kept = await refusalWith(undefined, [{ text: 'There were ~40 (estimated) transfers.', cites: [evidence.estimated] }, { text: 'Something else is listed.', cites: [] }], evidence);
    expect(shown(kept.answer)).toEqual(['There were ~40 (estimated) transfers.']);
  });

  it('canary: with the verdict test taken out of the product’s checks, the draft with verdict wording is shown, so the case above would fail', async () => {
    const evidence = await viewOf(labelled);
    const worded: SummarySentence = { text: 'This is evidence of fraud.', cites: [evidence.estimated] };
    const weakened = await refusalWith({ name: 'verdict wording', from: 'if (holdsVerdict(original, assembled)) {', to: 'if (false) {' }, [worded], evidence);
    expect(shown(weakened.answer)).toEqual(['This is evidence of fraud.']);
  });

  it('canary: with the test of the numbers taken out of the product’s checks, a sentence with a number its cited line does not hold is shown, so the case that drops it would fail', async () => {
    const evidence = await viewOf(labelled);
    const counted: SummarySentence = { text: `The ledger shows ${NUMBER_ON_THE_SECOND}.`, cites: [evidence.first, evidence.estimated] };
    expect(shown((await refusalWith(undefined, [counted], evidence)).answer)).toEqual([]);
    const weakened = await refusalWith({ name: 'numbers on the cited lines', from: 'if (!numbers.every((number) => cited.has(number))) return false;', to: '' }, [counted], evidence);
    expect(shown(weakened.answer)).toEqual([`The ledger shows ${NUMBER_ON_THE_SECOND}.`]);
  });

  it('states connections only: a sentence that rests on a node alone is not shown, and is shown when the option is taken away, so the case can fail', async () => {
    const evidence = await viewOf(labelled);
    const node: SummarySentence = { text: 'The first entity is listed.', cites: [evidence.first] };
    const link: SummarySentence = { text: 'There were ~40 (estimated) transfers.', cites: [evidence.estimated] };
    expect(shown((await refusalWith(undefined, [node, link], evidence)).answer)).toEqual(['There were ~40 (estimated) transfers.']);
    expect(shown((await refusalWith(undefined, [node], evidence)).answer)).toEqual([]);
    expect(shown((await refusalWith(undefined, [node, link], evidence, false)).answer)).toEqual(['The first entity is listed.', 'There were ~40 (estimated) transfers.']);
  });

  it('keeps the overview’s own contract as a second line: with the citation test taken out of the checks, a sentence that cites nothing still does not reach the answer', async () => {
    const evidence = await viewOf(labelled);
    const weakened = await refusalWith({ name: 'citations', from: 'return sentence.cites.length > 0 && sentence.cites.every((cite) => assembled.keys.has(cite));', to: 'return true;' }, [{ text: 'Something else is listed.', cites: [] }], evidence);
    expect(shown(weakened.answer)).toEqual([]);
  });
});
