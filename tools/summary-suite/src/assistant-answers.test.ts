import type { SummarySentence } from '@neburyx/contracts';
import { buildSummaryInstructions, createAuditedModelCall, promptRecordOf, type ModelProvider } from '@neburyx/ee-ask';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { caseOf, loadCases } from './cases.js';
import { NUMBER_ON_THE_SECOND } from './evidence.js';
import { mutatedChecks, type Mutation } from './mutants.js';
import { twinsOf, viewOf, type Evidence } from './rules.js';
import { node, reading } from './view.js';

type Counted = { readonly view: Evidence['view'] };
const set = loadCases();
const labelled = caseOf(set, 0);

afterEach(() => {
  vi.doUnmock('../../../ee/ask/src/case-summary/checks.js');
  vi.resetModules();
});

const VERDICT_TEST: Mutation = { name: 'verdict wording', from: 'if (holdsVerdict(original, assembled)) {', to: 'if (false) {' };
const NUMBERS_TEST: Mutation = { name: 'numbers on the cited lines', from: 'if (!numbers.every((number) => cited.has(number))) return false;', to: '' };
const CITATION_TEST: Mutation = { name: 'citations', from: 'return sentence.cites.length > 0 && sentence.cites.every((cite) => assembled.keys.has(cite));', to: 'return true;' };

/** What the model is scripted to say, for every call of the turn. */
type Script = string;
const sentencesOf = (...list: SummarySentence[]): Script => JSON.stringify({ sentences: list });

async function parts(mutation: Mutation | undefined, reply: Script) {
  vi.resetModules();
  if (mutation !== undefined) {
    const mutant = await mutatedChecks(mutation);
    vi.doMock('../../../ee/ask/src/case-summary/checks.js', () => mutant);
  }
  const { createCheckRunner } = await import('../../../ee/ai-runtime/src/index.js');
  const provider: ModelProvider = {
    complete: async (request) => ({ status: 'ok', text: reply, usage: { kind: 'known', inputTokens: 100, outputTokens: 20 }, model: 'claude-sonnet-5-5', prompt: promptRecordOf(request) }),
  };
  const model = createAuditedModelCall({ provider, configuration: { model: 'claude-sonnet-5-5' }, sink: { record: async () => undefined } });
  const instructions = () => buildSummaryInstructions('ANSWER PROMPT', '');
  return { createCheckRunner, model, instructions };
}

/** The answer from the view, drafted by the product's own view path and checks over one labelled view. */
async function viewAnswer(mutation: Mutation | undefined, reply: Script, evidence: Counted, form?: 'table') {
  const { createCheckRunner, model, instructions } = await parts(mutation, reply);
  const { createViewAnswer } = await import('../../../ee/ask/src/assistant/view-answer.js');
  const answer = createViewAnswer({ model, instructions, checks: createCheckRunner(), settings: () => ({ model: 'claude-sonnet-5-5', maxInputTokens: 25_000, maxCalls: 5, timeoutMs: 10_000, totalTimeoutMs: 180_000 }) });
  const reading = evidence.view;
  const refs = reading.nodes.map((node) => node.ref);
  const outcome = await answer({
    sourceId: refs[0]?.sourceId ?? 'demo',
    investigationId: 'inv-1',
    mask: false,
    message: 'What is in view?',
    viewElementKeys: refs.map((ref) => JSON.stringify(['node', ref.sourceId, ref.entityType, ref.stableId])),
    actorId: 'analyst-1',
    actorRole: 'investigator',
    traceId: 'trace-1',
    readElements: (async () => reading) as never,
    signal: new AbortController().signal,
    deadline: new AbortController().signal,
    callsUsed: 1,
    startedAt: Date.now(),
    progress: { calls: 0, read: 0, readStarted: false },
    ...(form === undefined ? {} : { form }),
  });
  return outcome;
}

/** The answer the agent's `answer` tool gives, over the same labelled view as what the turn read: the same basis, the same checks and the same outcome as the tool builds. */
async function toolAnswer(mutation: Mutation | undefined, reply: Script, evidence: Counted, form?: 'table') {
  const { createCheckRunner } = await parts(mutation, reply);
  const { answerBasisOf, outcomeOfDraft, withElementsOfNotes } = await import('../../../ee/ask/src/assistant/tool-answer.js');
  const { judgeCheck } = await import('../../../ee/ask/src/case-summary/judge.js');
  const { judgeTableRows, parseTable, rowSentenceOf } = await import('../../../ee/ask/src/assistant/table.js');
  const { assembleText } = await import('../../../ee/ask/src/case-summary/assemble.js');
  const reading = evidence.view;
  const scope = { request: { principalId: 'analyst-1', principalRole: 'investigator', traceId: 'trace-1', signal: new AbortController().signal }, sourceId: 'demo', investigationId: 'inv-1', ...(form === undefined ? {} : { form }) } as never;
  const basis = answerBasisOf({ reads: [], view: { assembled: assembleText(reading), reading }, scope, message: 'What is in view?' });
  if (basis === undefined) return { kind: 'unsupported' as const, calls: 0 };
  const checks = createCheckRunner();
  const signal = new AbortController().signal;
  const data = JSON.parse(reply) as { sentences?: SummarySentence[]; table?: unknown };
  const done = { reads: [], scope };
  if (form === 'table') {
    const draft = parseTable(data.table);
    if (draft === undefined) return { kind: 'unsupported' as const, calls: 0 };
    const rows = await judgeTableRows({ rows: draft.rows.map(rowSentenceOf), columns: draft.columns, checks, judge: judgeCheck, text: basis.checkedText, timeoutMs: 10_000, signal, drop: (row) => row.cites.some((key) => !basis.assembled.keys.has(key)) });
    if ('refused' in rows) return { kind: 'unsupported' as const, calls: 0 };
    if (rows.verdictFound || rows.kept.length === 0) return { kind: 'unsupported' as const, calls: 0 };
    return outcomeOfDraft({ drafted: { status: 'drafted', table: draft, sentences: rows.kept, removed: rows.removed, calls: 0, verdictFound: rows.verdictFound, model: 'claude-sonnet-5-5' }, basis, input: done, modelRef: 'claude-sonnet-5-5', keptRows: rows.positions, lastNames: undefined });
  }
  const checked = await checks.run(judgeCheck, { sentences: withElementsOfNotes(data.sentences ?? [], basis.noteElements), text: basis.checkedText }, { timeoutMs: 10_000, signal });
  if (checked.status === 'refused') return { kind: 'unsupported' as const, calls: 0 };
  return outcomeOfDraft({ drafted: { status: 'drafted', sentences: checked.value.kept, removed: checked.value.removed, calls: 0, verdictFound: checked.value.verdictFound, model: 'claude-sonnet-5-5' }, basis, input: done, modelRef: 'claude-sonnet-5-5', keptRows: [], lastNames: undefined });
}

type Path = (mutation: Mutation | undefined, reply: Script, evidence: Counted) => Promise<string[]>;

const viewPath: Path = async (mutation, reply, evidence) => {
  const outcome = await viewAnswer(mutation, reply, evidence);
  return outcome.status === 'answered' && 'sentences' in outcome.answer ? outcome.answer.sentences.map((sentence) => sentence.text) : [];
};
const toolPath: Path = async (mutation, reply, evidence) => {
  const outcome = await toolAnswer(mutation, reply, evidence);
  return outcome.kind === 'sentences' ? outcome.sentences.map((sentence) => sentence.text) : [];
};
const PATHS = [['the answer from the view', viewPath], ['the answer after tool steps', toolPath]] as const;

describe.each(PATHS)('%s, over a labelled view, with the product’s own checks', (_name, path) => {
  it('drops a sentence that cites nothing and one that cites a key nobody sent, and keeps the cited one beside them', async () => {
    const evidence = await viewOf(labelled);
    const good: SummarySentence = { text: 'There were ~40 (estimated) transfers.', cites: [evidence.estimated] };
    expect(await path(undefined, sentencesOf(good, { text: 'Something else is listed.', cites: [] }, { text: 'A ghost is listed.', cites: ['n99'] }), evidence)).toEqual(['There were ~40 (estimated) transfers.']);
  });

  it('drops a sentence with a number its cited line does not hold, and the canary shows it when the test of the numbers is taken out', async () => {
    const evidence = await viewOf(labelled);
    const counted: SummarySentence = { text: `The ledger shows ${NUMBER_ON_THE_SECOND}.`, cites: [evidence.first, evidence.estimated] };
    expect(await path(undefined, sentencesOf(counted), evidence)).toEqual([]);
    expect(await path(NUMBERS_TEST, sentencesOf(counted), evidence)).toEqual([`The ledger shows ${NUMBER_ON_THE_SECOND}.`]);
  });

  it('rejects a reply with verdict wording whole, and the canary shows it when the test of verdict wording is taken out', async () => {
    const evidence = await viewOf(labelled);
    const good: SummarySentence = { text: 'There were ~40 (estimated) transfers.', cites: [evidence.estimated] };
    const worded: SummarySentence = { text: 'This is evidence of fraud.', cites: [evidence.estimated] };
    expect(await path(undefined, sentencesOf(good, worded), evidence)).toEqual([]);
    expect(await path(VERDICT_TEST, sentencesOf(worded), evidence)).toEqual(['This is evidence of fraud.']);
  });

  it('canary: with the citation test taken out, a sentence that cites a key nobody sent is shown, so the case that drops it would fail', async () => {
    const evidence = await viewOf(labelled);
    const ghost: SummarySentence = { text: 'The first entity is listed.', cites: ['n99'] };
    expect(await path(undefined, sentencesOf(ghost), evidence)).toEqual([]);
    expect(await path(CITATION_TEST, sentencesOf(ghost), evidence)).toEqual(['The first entity is listed.']);
  });
});

describe.each(PATHS)('%s: a count of the cited elements, over a labelled view, with the product’s own checks', (_name, path) => {
  const sayOf = (type: string, number: number, lead = ''): string => `${lead}${number} ${type.toLowerCase().replaceAll('_', ' ')}s are listed.`;

  it('shows the count that equals the number of cited elements of the named type, and removes the next one', async () => {
    const evidence = await viewOf(labelled);
    const { type, keys } = twinsOf(labelled, evidence);
    expect(await path(undefined, sentencesOf({ text: sayOf(type, keys.length), cites: [...keys] }), evidence)).toEqual([sayOf(type, keys.length)]);
    expect(await path(undefined, sentencesOf({ text: sayOf(type, keys.length + 1), cites: [...keys] }), evidence)).toEqual([]);
  });

  it.each(['At least ', 'In total '])('removes a count of cited elements said of another population (%s), and the canary shows it when the test of the population is taken out', async (lead) => {
    const evidence = await viewOf(labelled);
    const { type, keys } = twinsOf(labelled, evidence);
    const sentence: SummarySentence = { text: sayOf(type, keys.length, lead), cites: [...keys] };
    expect(await path(undefined, sentencesOf(sentence), evidence)).toEqual([]);
    expect(await path({ name: 'the population of a count', from: " || OTHER_POPULATION.test(sentence.text.replace(/\\s+/gu, ' '))", to: '' }, sentencesOf(sentence), evidence)).toEqual([sentence.text]);
  });
});

describe.each(PATHS)('%s: 25 transactions over 25 cited transactions, with the product’s own checks', (_name, path) => {
  const transactions = Array.from({ length: 25 }, (_, index) => node('transaction', `T-${index + 1}`, `Transfer T-${index + 1}`));
  const cites = transactions.map((_, index) => `n${index + 1}`);
  const evidence: Counted = { view: reading(transactions) };

  it('shows 25 and removes 26', async () => {
    expect(await path(undefined, sentencesOf({ text: '25 transactions are listed.', cites }), evidence)).toEqual(['25 transactions are listed.']);
    expect(await path(undefined, sentencesOf({ text: '26 transactions are listed.', cites }), evidence)).toEqual([]);
  });
});

const tableOf = (columns: string[], ...rows: { cells: string[]; cites: string[] }[]): Script => JSON.stringify({ table: { columns, rows } });

const tableViewPath = async (mutation: Mutation | undefined, reply: Script, evidence: Counted): Promise<string[][]> => {
  const outcome = await viewAnswer(mutation, reply, evidence, 'table');
  return outcome.status === 'answered' && 'table' in outcome.answer ? outcome.answer.table.rows.map((row) => row.cells) : [];
};
const tableToolPath = async (mutation: Mutation | undefined, reply: Script, evidence: Counted): Promise<string[][]> => {
  const outcome = await toolAnswer(mutation, reply, evidence, 'table');
  return outcome.kind === 'table' ? outcome.table.rows.map((row) => row.cells) : [];
};

describe.each([['a table answer from the view', tableViewPath, true], ['a table answer after tool steps', tableToolPath, false]] as const)('%s, over a labelled view, with the product’s own checks', (_name, path, citationCanaryHolds) => {
  const rowOf = (evidence: Evidence, over: Partial<{ cells: string[]; cites: string[] }> = {}) => {
    const node = evidence.view.nodes[0];
    return { cells: [node?.display.title ?? '', node?.display.type ?? ''], cites: [evidence.first], ...over };
  };
  const COLUMNS = ['Element', 'Type'];

  it('keeps the row that copies the element it cites and drops a row that cites a key nobody sent; a row that cites nothing refuses the reply whole', async () => {
    const evidence = await viewOf(labelled);
    const good = rowOf(evidence);
    expect(await path(undefined, tableOf(COLUMNS, good, rowOf(evidence, { cites: ['n99'] })), evidence)).toEqual([good.cells]);
    expect(await path(undefined, tableOf(COLUMNS, good, rowOf(evidence, { cites: [] })), evidence)).toEqual([]);
  });

  it('drops a row with a number its cited element does not hold, and the canary shows it when the test of the numbers is taken out', async () => {
    const evidence = await viewOf(labelled);
    const counted = rowOf(evidence, { cells: [`Ledger ${NUMBER_ON_THE_SECOND}`, 'entity'] });
    expect(await path(undefined, tableOf(COLUMNS, counted), evidence)).toEqual([]);
    expect(await path(NUMBERS_TEST, tableOf(COLUMNS, counted), evidence)).toEqual([counted.cells]);
  });

  it('refuses a table with a verdict word in a cell, and the canary shows the row when the test of verdict wording is taken out', async () => {
    const evidence = await viewOf(labelled);
    const worded = rowOf(evidence, { cells: ['fraud', 'entity'] });
    expect(await path(undefined, tableOf(COLUMNS, rowOf(evidence), worded), evidence)).toEqual([]);
    expect(await path(VERDICT_TEST, tableOf(COLUMNS, worded), evidence)).toEqual([worded.cells]);
  });

  if (citationCanaryHolds) {
    it('canary: with the citation test taken out, a row that cites a key nobody sent is shown, so the case that drops it would fail', async () => {
      const evidence = await viewOf(labelled);
      const ghost = rowOf(evidence, { cites: ['n99'] });
      expect(await path(undefined, tableOf(COLUMNS, ghost), evidence)).toEqual([]);
      expect(await path(CITATION_TEST, tableOf(COLUMNS, ghost), evidence)).toEqual([ghost.cells]);
    });
  } else {
    it('still drops a row that cites a key nobody sent when the citation test is taken out, because the table’s own check of its keys does (no canary of the shared test can be built on this path)', async () => {
      const evidence = await viewOf(labelled);
      const ghost = rowOf(evidence, { cites: ['n99'] });
      expect(await path(CITATION_TEST, tableOf(COLUMNS, ghost), evidence)).toEqual([]);
    });
  }
});
