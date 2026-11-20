import { ExtensionRefusal, type AskFolder } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { buildPatternCatalog } from '../patterns/index.js';
import { loadAskFolder } from '../folder/load.js';
import { capabilitiesOf } from '../questions/question-routes.js';
import { makeAskFolder, removeAskFolders } from '../testing/ask-folder.js';
import { VIEW_KEYS, fileQueryResult, heavyResult, offerOf, okResult, rig, type Rig } from '../testing/assistant-rig.js';
import { buildToolRegistry } from './tool-registry.js';
import { readToolRequest } from './tool-request.js';
import { runToolStep, type StepScope } from './tool-step.js';

afterAll(removeAskFolders);

const SOURCE = 'demo';
const PATTERN = { ...offerOf('11111111-1111-4111-8111-111111111111', 'Mine'), projection: { ...offerOf('x', 'y').projection, startingEntity: 'asked' as const } };

async function folderOf(): Promise<AskFolder> {
  const loaded = await loadAskFolder({ folder: makeAskFolder([SOURCE]), sourceIds: [SOURCE] });
  if (!loaded.ok) throw new Error('the test folder did not load');
  return loaded.folder;
}

async function setup(options: Parameters<typeof rig>[0] = {}) {
  const t = await rig({ ...options, patterns: [PATTERN] });
  const folder = await folderOf();
  const built = buildPatternCatalog({ offers: [PATTERN], cut: false });
  const registry = buildToolRegistry({ source: folder.source(SOURCE), patterns: built, viewReadable: true, templateRunnable: () => true });
  const ask = (text: string) => {
    const read = readToolRequest(text, registry);
    if (!read.ok) throw new Error('the test request is malformed');
    return read.request;
  };
  const scope = (request = t.request(), mask = false): StepScope => ({
    request,
    capabilities: capabilitiesOf(request),
    options: { folder: () => folder, runs: () => undefined, logger: () => undefined },
    action: 'assistant.ask',
    sourceId: SOURCE,
    mask,
    investigationId: 'inv-1',
    viewElementKeys: VIEW_KEYS,
    ...(built === undefined ? {} : { patterns: { built, listing: { offers: [PATTERN], cut: false } } }),
  });
  return { t, ask, scope };
}
const calls = (t: Rig) => t.runs.length;

describe('a tool step through the gate', () => {
  it('starts no step for a turn that was cancelled, and reads nothing', async () => {
    const controller = new AbortController();
    const { t, ask, scope } = await setup();
    controller.abort();
    await expect(runToolStep(ask('{"tool":"byId","values":{"id":"A-1"}}'), scope(t.request(undefined, { signal: controller.signal })))).rejects.toThrow('cancelled');
    expect(calls(t)).toBe(0);
  });

  it('throws the refusal of the gate for the turn to answer, and starts nothing after it', async () => {
    const { t, ask, scope } = await setup({ runThrows: new ExtensionRefusal({ code: 'QUERY_TIMEOUT', timeoutMs: 1 }) });
    await expect(runToolStep(ask('{"tool":"byId","values":{"id":"A-1"}}'), scope())).rejects.toBeInstanceOf(ExtensionRefusal);
    expect(calls(t)).toBe(1);
  });

  it('runs a folder intent as a file query, its values only as parameters, masked as the request asks, and answers with its rows', async () => {
    const { t, ask, scope } = await setup({ run: () => ({ status: 'ok', result: fileQueryResult() }) });
    const step = await runToolStep(ask('{"tool":"byId","values":{"id":"A-1"}}'), scope(t.request(), true));
    expect(t.runs).toEqual([{ asked: { fileQuery: { intent: 'byId', values: { id: 'A-1' } } }, options: undefined, mask: true }]);
    expect(step).toMatchObject({ status: 'answered', rows: 2 });
  });

  it('runs a template intent as Ask runs it', async () => {
    const { t, ask, scope } = await setup({ run: () => ({ status: 'ok', result: okResult() }) });
    const step = await runToolStep(ask('{"tool":"shared","values":{"id":"A-1"}}'), scope());
    expect(t.runs[0]?.asked).toMatchObject({ templateId: 'shared-attribute' });
    expect(step.status).toBe('answered');
  });

  it('runs a saved pattern as Ask runs it, with its anchor as the only value', async () => {
    const { t, ask, scope } = await setup({ run: () => ({ status: 'ok', result: okResult() }) });
    const step = await runToolStep(ask('{"tool":"pat_1","values":{"anchor":"W-1"}}'), scope());
    expect(t.runs[0]?.asked).toMatchObject({ templateId: 'saved-pattern', params: { patternId: PATTERN.id, ref: { stableId: 'W-1' } } });
    expect(step.status).toBe('answered');
  });

  it('does not read further a result Ask would stop as heavy, and keeps its continue token', async () => {
    const { ask, scope } = await setup({ run: () => ({ status: 'ok', result: heavyResult() }) });
    const step = await runToolStep(ask('{"tool":"shared","values":{"id":"A-1"}}'), scope());
    expect(step.status).toBe('heavy');
    expect(step.status === 'heavy' && typeof step.answer.continueToken).toBe('string');
  });

  it('answers a read that finds nothing as Ask answers it, a refusal', async () => {
    const empty = { ...fileQueryResult() };
    const { ask, scope } = await setup({ run: () => ({ status: 'ok', result: { templateId: 'file-query', result: { ...(empty.templateId === 'file-query' ? empty.result : {}), nodes: [], edges: [] } } as never }) });
    expect((await runToolStep(ask('{"tool":"byId","values":{"id":"A-9"}}'), scope())).status).toBe('refused');
  });

  it('reads the view again through the gate from the keys, and answers with the elements it read', async () => {
    const { t, ask, scope } = await setup();
    const step = await runToolStep(ask('{"tool":"view","values":{}}'), scope(t.request(), true));
    expect(t.elementReads).toHaveLength(1);
    expect(t.elementReads[0]?.mask).toBe(true);
    expect(step).toMatchObject({ status: 'view', rows: 2 });
  });

  it('answers that there is no view when the keys are not the keys of the source, and reads nothing', async () => {
    const { t, ask, scope } = await setup();
    const none = { ...scope(), viewElementKeys: ['not a key'] };
    expect((await runToolStep(ask('{"tool":"view","values":{}}'), none)).status).toBe('no-view');
    expect(t.elementReads).toHaveLength(0);
  });

  describe('a catalog template asked for by its id', () => {
    it('runs as Ask runs a template intent, its text values only as the typed parameters of the anchor', async () => {
      const { t, ask, scope } = await setup({ run: () => ({ status: 'ok', result: okResult() }) });
      const step = await runToolStep(ask('{"tool":"degree-preview","values":{"entityType":"widget","stableId":"A-1"}}'), scope(t.request(), true));
      expect(t.runs).toEqual([{ asked: { templateId: 'degree-preview', params: { ref: { entityType: 'widget', stableId: 'A-1' } } }, options: undefined, mask: true }]);
      expect(step.status).toBe('answered');
    });

    it('places both ends of a path search and fixes what a request cannot choose', async () => {
      const { t, ask, scope } = await setup({ run: () => ({ status: 'ok', result: okResult() }) });
      await runToolStep(ask('{"tool":"shortest-paths","values":{"fromType":"widget","fromId":"A-1","toType":"Person","toId":"P-1","relType":"OWNS"}}'), scope());
      expect(t.runs[0]?.asked).toEqual({
        templateId: 'shortest-paths',
        params: { ends: [{ entityType: 'widget', stableId: 'A-1' }, { entityType: 'Person', stableId: 'P-1' }], relTypes: ['OWNS'], maxHops: 3, limit: 10 },
      });
    });

    it('does not read further a result Ask would stop as heavy, and the stop continues', async () => {
      const { ask, scope } = await setup({ run: () => ({ status: 'ok', result: heavyResult() }) });
      const step = await runToolStep(ask('{"tool":"entity","values":{"entityType":"widget","stableId":"A-1"}}'), scope());
      expect(step.status).toBe('heavy');
    });

    it('throws the refusal of the gate for an entity type the mapping does not know, after one attempt', async () => {
      const { t, ask, scope } = await setup({ runThrows: new ExtensionRefusal({ code: 'INVALID_REQUEST', reason: 'unknown-entity-type' }) });
      await expect(runToolStep(ask('{"tool":"entity","values":{"entityType":"Nope","stableId":"A-1"}}'), scope())).rejects.toBeInstanceOf(ExtensionRefusal);
      expect(calls(t)).toBe(1);
    });

    it('answers as refused, with the turn going on, for an entity type the gate refuses as not fitting what the source can run', async () => {
      const { ask, scope } = await setup({ runThrows: new ExtensionRefusal({ code: 'ASK_INTENT_INVALID' }) });
      expect(await runToolStep(ask('{"tool":"entity","values":{"entityType":"Nope","stableId":"A-1"}}'), scope())).toMatchObject({ status: 'refused', refused: { cause: 'invalid-inputs' } });
    });

    it('is malformed, and nothing runs, with a value missing, one more than the template takes, or a value that is not text', async () => {
      const { t } = await setup();
      const registry = buildToolRegistry({ source: (await folderOf()).source(SOURCE), patterns: undefined, viewReadable: false, templateRunnable: () => true });
      for (const text of ['{"tool":"entity","values":{"entityType":"widget"}}', '{"tool":"entity","values":{"entityType":"widget","stableId":"A-1","limit":"5"}}', '{"tool":"entity","values":{"entityType":"widget","stableId":["A-1"]}}']) {
        expect(readToolRequest(text, registry)).toEqual({ ok: false, reason: 'malformed' });
      }
      expect(calls(t)).toBe(0);
    });

    it('is unavailable without its manual capability, and nothing runs', async () => {
      const { t } = await setup();
      const registry = buildToolRegistry({ source: (await folderOf()).source(SOURCE), patterns: undefined, viewReadable: false, templateRunnable: (template) => template !== 'shortest-paths' });
      expect(readToolRequest('{"tool":"shortest-paths","values":{"fromType":"A","fromId":"1","toType":"B","toId":"2","relType":"R"}}', registry)).toEqual({ ok: false, reason: 'unavailable' });
      expect(calls(t)).toBe(0);
    });
  });
});
