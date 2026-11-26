import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readClassification, type AskClassification, type AskClassifier } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { fileQueryDepsOf } from '../gate/file-query.js';
import { parseMapping } from '../mapping/load.js';
import { packMappingText, type Pack } from '../testing/pack-fixtures.js';
import { communitySeams } from '../seams/community-seams.js';
import type { AuditEvent } from '../seams/seams.js';
import { startSearchApp } from '../testing/search-app.js';
import { configuredWith, copyOfAskFolder, demoPacks, removeDemoFolders, type DemoPack, type DemoQuestion } from '../testing/demo-packs.js';

afterAll(removeDemoFolders);

const packs = demoPacks();
const post = (app: Awaited<ReturnType<typeof startSearchApp>>['app'], url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: JSON.stringify(payload), headers: { 'content-type': 'application/json' } });
const noRows = () => Promise.resolve({ status: 'rows' as const, rows: [] });

/** The scripted reply of a question: exactly the right one, as the model should write it, read by the product's strict reader with the folder's intent names. */
function scriptedClassifier(pack: DemoPack, overrides: ReadonlyMap<string, string> = new Map()): AskClassifier {
  const names = Object.keys(pack.intents);
  return {
    availability: () => ({ available: true }),
    classify: async (input): Promise<AskClassification> => {
      const question = pack.questions.find((candidate) => candidate.wording === input.question);
      if (question === undefined) throw new Error('a question that is not in the set');
      const text = overrides.get(question.id) ?? JSON.stringify(question.expect === 'refuse' ? { intent: null, entities: {} } : question.expect);
      const read = readClassification(text, names);
      if (!read.ok) return { ok: false, cause: read.cause };
      return read.intent === null ? { ok: false, cause: 'no-intent' } : { ok: true, intent: read.intent, entities: read.entities };
    },
  };
}

async function started(pack: DemoPack, options: { readonly folder?: string; readonly overrides?: ReadonlyMap<string, string>; readonly audited?: AuditEvent[] } = {}) {
  const folder = options.folder ?? copyOfAskFolder(pack);
  const { extension, outcome } = await configuredWith(folder, [pack.sourceId]);
  expect(outcome).toEqual({ ok: true });
  const mapping = parseMapping(packMappingText(pack.pack as Pack), 'neburyx.yaml');
  // the events of the gate and of the extension's own routes, in one list
  const audit = options.audited === undefined ? undefined : { record: (event: AuditEvent) => Promise.resolve(void options.audited?.push(event)) };
  const seams = { ...communitySeams(), ...(audit === undefined ? {} : { audit }), askClassifier: scriptedClassifier(pack, options.overrides) };
  const rig = await startSearchApp({ mapping, respond: noRows, fileQueries: fileQueryDepsOf(() => extension.askFolder?.()), ...(audit === undefined ? {} : { audit }), appOptions: { extension, previewOn: true, seams } });
  return { ...rig, extension };
}

describe.each(packs.map((pack) => [pack.pack, pack] as const))('every question of the %s pack, from the question to the run', (_name, pack: DemoPack) => {
  it('runs the intent each question expects through the real route, runner and gate: the values reach the source as parameters, and a query is the folder\'s own text', async () => {
    const { app, executor } = await started(pack);
    for (const question of pack.questions) {
      if (question.expect === 'refuse') continue;
      const before = executor.calls.length;
      const answer = await post(app, '/v1/ask', { sourceId: pack.sourceId, question: question.wording });
      expect(answer.statusCode, `${question.id} ${answer.body}`).toBe(200);
      const body = answer.json();
      expect(body.answered?.intent ?? 'refused', question.id).toBe(body.answered ? question.expect.intent : 'refused');
      if (body.refused) expect(body.refused.cause, question.id).toBe('nothing-found');
      const calls = executor.calls.slice(before).filter((call) => !call.templateId.startsWith('schema-'));
      expect(calls.length, question.id).toBeGreaterThan(0);
      const sent = JSON.stringify(calls.map((call) => call.parameters));
      for (const value of Object.values(question.expect.entities)) expect(sent, question.id).toContain(value);
      const intent = pack.intents[question.expect.intent];
      if (intent?.query !== undefined) expect(calls.some((call) => call.cypher === intent.query), question.id).toBe(true);
    }
    await app.close();
  });

  it('refuses the name query while masking is on, before the source, and audits the question as refused with the reason of the gate', async () => {
    const question = pack.questions.find((candidate) => candidate.expect !== 'refuse' && pack.intents[candidate.expect.intent]?.query !== undefined);
    if (question === undefined) throw new Error('the pack has no name question');
    const audited: AuditEvent[] = [];
    const { app, executor } = await started(pack, { audited });
    const before = executor.calls.length;
    const answer = await post(app, '/v1/ask', { sourceId: pack.sourceId, question: question.wording, mask: true });
    expect(answer.statusCode, answer.body).toBe(400);
    expect(executor.calls.slice(before).filter((call) => !call.templateId.startsWith('schema-'))).toEqual([]);
    await app.close();
    expect(audited.find((event) => event.action === 'ask.file_query')).toMatchObject({ result: 'refused', detail: { reason: 'file-query-masked' } });
    expect(audited.find((event) => event.action === 'ask.question')).toMatchObject({ result: 'refused', detail: { askRun: { kind: 'query', outcome: 'refused', cause: 'file-query-masked' } } });
  });

  it('refuses every question that expects no intent with the cause no-intent, and runs nothing against the source', async () => {
    const { app, executor } = await started(pack);
    const before = executor.calls.length;
    const refusals = pack.questions.filter((question) => question.expect === 'refuse');
    expect(refusals.length).toBeGreaterThan(0);
    for (const question of refusals) {
      const answer = await post(app, '/v1/ask', { sourceId: pack.sourceId, question: question.wording });
      expect(answer.statusCode, question.id).toBe(200);
      expect(answer.json(), question.id).toMatchObject({ refused: { cause: 'no-intent' } });
    }
    expect(executor.calls.length).toBe(before);
    await app.close();
  });

  it('refuses a reply with an unknown intent, a missing entity and an extra entity, each with its own cause, and runs nothing', async () => {
    const question = pack.questions.find((candidate): candidate is DemoQuestion & { expect: { intent: string; entities: Record<string, string> } } => candidate.expect !== 'refuse');
    if (question === undefined) throw new Error('no question to build from');
    const [first] = Object.keys(question.expect.entities);
    const replies = new Map([
      ['unknown', JSON.stringify({ intent: 'not-an-intent-of-the-folder', entities: question.expect.entities })],
      ['missing', JSON.stringify({ intent: question.expect.intent, entities: {} })],
      ['extra', JSON.stringify({ intent: question.expect.intent, entities: { ...question.expect.entities, [`${first ?? 'x'}_more`]: 'x' } })],
    ]);
    for (const [kind, text] of replies) {
      const { app, executor } = await started(pack, { overrides: new Map([[question.id, text]]) });
      const answer = await post(app, '/v1/ask', { sourceId: pack.sourceId, question: question.wording });
      expect(answer.statusCode, kind).toBe(200);
      expect(answer.json().refused?.cause, kind).toBe({ unknown: 'unknown-intent', missing: 'missing-inputs', extra: 'extra-inputs' }[kind]);
      expect(executor.calls.filter((call) => !call.templateId.startsWith('schema-')), kind).toEqual([]);
      await app.close();
    }
  });

  it('is refused by the gate when an intent names a type, a relationship or a rule the pack\'s mapping does not have', async () => {
    const [name, intent] = Object.entries(pack.intents).find(([, found]) => found.template === 'linked-entities' || found.template === 'shared-attribute') ?? [];
    const question = pack.questions.find((candidate) => candidate.expect !== 'refuse' && candidate.expect.intent === name);
    if (name === undefined || intent === undefined || question === undefined) throw new Error('no intent to break');
    const folder = copyOfAskFolder(pack, (subfolder) => {
      const text = JSON.stringify({ ...pack.intents, [name]: { ...intent, settings: JSON.parse(JSON.stringify(intent.settings).replace(/"(attributeType|targetType)":"[^"]+"/, '"$1":"not-a-type-of-the-pack"')) } });
      writeFileSync(join(subfolder, 'intents.json'), text);
    });
    const { app } = await started(pack, { folder });
    const answer = await post(app, '/v1/ask', { sourceId: pack.sourceId, question: question.wording });
    expect(answer.statusCode, answer.body).toBeGreaterThanOrEqual(400);
    expect(answer.json().error.code).toBe('ASK_INTENT_INVALID');
    await app.close();
  });
});
