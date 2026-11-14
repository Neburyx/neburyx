import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createEnterpriseExtension } from '@neburyx/ee-ask';
import { SHARED_ATTRIBUTE_COUNT_ID } from '../../../services/api/src/gate/templates/shared-attribute-count.js';
import { removeAskFolders } from '../../../services/api/src/testing/ask-folder.js';
import { entityRows } from '../../../services/api/src/testing/entity-fixtures.js';
import { widget } from '../../../services/api/src/testing/search-app.js';
import { sharedMappingOf, sharedRow } from '../../../services/api/src/testing/shared-attribute-fixtures.js';
import type { ExecuteCall } from '../../../services/api/src/gate/executor.js';
import { expectOnlyParameters, SafetyCheckFailed } from './checks.js';
import { FILE_QUERY, folderOf, reply, SHARED_INTENTS } from './fixtures.js';
import { HARMLESS_VALUE, HOSTILE_VALUES } from './hostile.js';
import { recordingRunStore, startRig, type Rig } from './rig.js';
import { startModelStub, type ModelStub } from './stub.js';

vi.mock('@neburyx/ee-audit', async () => (await import('./mock-audit.js')).auditMock);

let stub: ModelStub;
beforeAll(async () => {
  stub = await startModelStub();
});
afterAll(async () => {
  removeAskFolders();
  await stub.close();
});

async function widgetRig(): Promise<Rig> {
  const store = recordingRunStore();
  const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: store.factory });
  return startRig({ extension, stub, rows: store.rows, folder: folderOf(), respond: () => Promise.resolve(entityRows(widget(1))) });
}

/** The shared-attribute template on a mapping whose threshold is three, so a count of four stops the run as heavy. */
async function heavyRig(): Promise<Rig> {
  const store = recordingRunStore();
  const extension = createEnterpriseExtension({ modelBaseUrl: stub.baseUrl, runStore: store.factory });
  return startRig({
    extension,
    stub,
    rows: store.rows,
    folder: folderOf(SHARED_INTENTS),
    mapping: sharedMappingOf({ budgets: { heavy_op_threshold: 3 } }),
    respond: (call: ExecuteCall) => Promise.resolve(call.templateId === SHARED_ATTRIBUTE_COUNT_ID ? { status: 'rows' as const, rows: [{ matches: 4, anchorBounded: false, skipped: false }] } : { status: 'rows' as const, rows: [sharedRow({ match: 'O-1' })] }),
  });
}

/** A value that holds a control character does not fit a reference or a search text, and one over this many characters does not fit a search text. */
const refusedBeforeAnyRead = (value: string, textLimit = Infinity): boolean => /[\u0000-\u001f]/.test(value) || [...value].length > textLimit;
const SEARCH_TEXT_LIMIT = 200;

/** Every read of `after` is a statement the harmless run sent for the same template, and the value is a parameter of one of them. */
function expectSameStatements(harmless: readonly ExecuteCall[], after: readonly ExecuteCall[], value: string): void {
  if (after.length === 0) throw new SafetyCheckFailed('no read reached the source, so nothing was checked');
  const known = new Map<string, Set<string>>();
  for (const read of harmless) known.set(read.templateId, (known.get(read.templateId) ?? new Set<string>()).add(read.cypher));
  for (const read of after) if (known.get(read.templateId)?.has(read.cypher) !== true) throw new SafetyCheckFailed(`a statement of ${read.templateId} that the harmless run did not send`);
  if (!after.some((read) => Object.values(read.parameters).includes(value))) throw new SafetyCheckFailed('the value did not reach the source as a parameter');
}

const sentinelsAndValues = HOSTILE_VALUES.map((entry) => [entry.name, entry.value] as const);

describe('an entity value that looks like query text reaches the source only as a parameter', () => {
  it.each(sentinelsAndValues)('runs the folder\'s own query text for a value that holds %s, with the value as a parameter', async (_name, value) => {
    const rig = await widgetRig();
    const answer = await rig.ask('Find it', reply('byId', { id: value }));
    // a control character does not fit a reference, so it is refused before any read; every other value must reach the source
    if (/[\u0000-\u001f]/.test(value)) {
      expect(answer.body).toMatchObject({ refused: expect.anything() });
      expect(rig.reads()).toEqual([]);
    } else expectOnlyParameters(rig.reads(), { text: FILE_QUERY, values: [value] });
    await rig.close();
  });

  it.each(sentinelsAndValues)('sends the same statement of the entity template as for a harmless value, for a value that holds %s', async (_name, value) => {
    const rig = await widgetRig();
    await rig.ask('Show it', reply('widgetById', { id: HARMLESS_VALUE }));
    const harmless = rig.reads();
    expect(harmless.length).toBeGreaterThan(0);
    const answer = await rig.ask('Show it', reply('widgetById', { id: value }));
    const reads = rig.reads().slice(harmless.length);
    if (refusedBeforeAnyRead(value)) {
      expect(answer.body).toMatchObject({ refused: expect.anything() });
      expect(reads).toEqual([]);
    } else expectSameStatements(harmless, reads, value);
    await rig.close();
  });

  it.each(sentinelsAndValues)('sends a value that holds %s in a search as a parameter of the search\'s own statements', async (_name, value) => {
    const rig = await widgetRig();
    await rig.ask('Find widgets', reply('findWidgets', { q: HARMLESS_VALUE }));
    const harmless = rig.reads();
    expect(harmless.length).toBeGreaterThan(0);
    const answer = await rig.ask('Find widgets', reply('findWidgets', { q: value }));
    const reads = rig.reads().slice(harmless.length);
    if (refusedBeforeAnyRead(value, SEARCH_TEXT_LIMIT)) {
      expect(answer.body).toMatchObject({ refused: expect.anything() });
      expect(reads).toEqual([]);
    } else expectSameStatements(harmless, reads, value);
    await rig.close();
  });

  it('runs a value that is a placeholder or the name of a parameter as plain text, once', async () => {
    const rig = await widgetRig();
    for (const value of ['$id', '$q', '${id}', '$$id']) {
      const before = rig.reads().length;
      await rig.ask('Find it', reply('byId', { id: value }));
      expectOnlyParameters(rig.reads().slice(before), { text: FILE_QUERY, values: [value] });
    }
    await rig.close();
  });

  it('refuses a value over the limit of the entity before any read', async () => {
    const rig = await widgetRig();
    expect((await rig.ask('Find it', reply('byId', { id: 'x'.repeat(257) }))).body).toMatchObject({ refused: expect.anything() });
    expect(rig.reads()).toEqual([]);
    await rig.close();
  });

  it('keeps a hostile value a parameter through Continue: the heavy stop is continued with the same entities and the same statements as for a harmless value', async () => {
    const rig = await heavyRig();
    const pageOf = async (entity: string): Promise<ExecuteCall[]> => {
      const stop = await rig.ask('Who shares a tool?', reply('sharedWith', { id: entity }));
      expect(stop.body).toMatchObject({ answered: { outcome: 'partial', continueToken: expect.any(String) } });
      const before = rig.reads().length;
      const page = await rig.post('/v1/ask/continue', { sourceId: 'demo', intent: 'sharedWith', entities: { id: entity }, continueToken: (stop.body['answered'] as { continueToken: string }).continueToken });
      expect(page.body).toMatchObject({ answered: { outcome: expect.any(String) } });
      return rig.reads().slice(before);
    };
    const harmless = await pageOf(HARMLESS_VALUE);
    expect(harmless.length).toBeGreaterThan(0);
    const entity = HOSTILE_VALUES[0]?.value ?? '';
    const requestsBefore = stub.requests.length;
    const page = await pageOf(entity);
    expectSameStatements(harmless, page, entity);
    expect(stub.requests.length - requestsBefore).toBe(1);
    await rig.close();
  });

  it('canary: the check fails when a leaky executor puts the first value into the statement', async () => {
    const rig = await widgetRig();
    await rig.ask('Find it', reply('byId', { id: HOSTILE_VALUES[0]?.value ?? '' }));
    const leaky = rig.reads().map((read) => ({ cypher: `${read.cypher} // ${Object.values(read.parameters)[0]}`, parameters: read.parameters }));
    expect(leaky[0]?.cypher).toContain(HOSTILE_VALUES[0]?.sentinel ?? 'missing');
    expect(() => expectOnlyParameters(leaky, { text: FILE_QUERY, values: [] })).toThrow(SafetyCheckFailed);
    await rig.close();
  });
});
