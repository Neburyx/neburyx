import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSISTANT_FOLLOW_UPS_MAX, askAnswerSchema, askRunResultSchema, type AskAnswer, type AskFolder, type AskIntent, type AssistantChoice } from '@neburyx/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import { loadAskFolder } from '../folder/load.js';
import { refusal } from '../questions/question-routes.js';
import { heavyResult } from '../testing/assistant-rig.js';
import { roleEntityType } from './clarification.js';
import { followUpsOf } from './follow-ups.js';

const SOURCE = 'demo';
const PACKS = fileURLToPath(new URL('../../../../domain-packs', import.meta.url));
const made: string[] = [];
afterAll(() => {
  for (const path of made) rmSync(path, { recursive: true, force: true });
});

const nodeOf = (entityType: string, stableId: string) => ({
  ref: { sourceId: SOURCE, entityType, stableId },
  display: { title: `Title ${stableId}`, type: entityType },
  properties: [],
  qualityFlags: [],
  provenanceRefs: [],
  authorization: { canInspect: true, canExport: true },
});

const answerOf = (intent: string, nodes: readonly ReturnType<typeof nodeOf>[]): AskAnswer =>
  askAnswerSchema.parse({
    answered: {
      intent,
      entities: {},
      outcome: 'complete',
      result: askRunResultSchema.parse({ templateId: 'shared-attribute', result: { status: 'ok', templateId: 'shared-attribute', templateVersion: '1', count: { quality: 'exact', value: nodes.length, scope: 'test' }, matchIds: [], nodes, edges: [], notices: [], warnings: [] } }),
    },
  });

const entityIntent = (name: string, entityType: string): AskIntent => ({ name, parameters: ['id'], kind: 'template', template: 'entity', settings: { ref: { entityType, stableId: '$id' } } });
const pairIntent = (name: string, entityType: string): AskIntent => ({ name, parameters: ['a', 'b'], kind: 'template', template: 'shortest-paths', settings: { ends: [{ entityType, stableId: '$a' }, { entityType, stableId: '$b' }] } });
const queryIntent: AskIntent = { name: 'byId', parameters: ['id'], kind: 'query', query: { text: 'MATCH (n) RETURN n', sha256: 'a'.repeat(64) } };

const folderOf = (intents: readonly AskIntent[]): AskFolder => ({
  sourceIds: [SOURCE],
  source: () => ({ classification: { text: '', sha256: '' }, intents }),
  intent: (_sourceId, name) => intents.find((intent) => intent.name === name),
});

const seal = (intent: string, roles: readonly string[], entities: Record<string, string>): AssistantChoice => ({ intent, roles: [...roles], entities, choiceToken: `${'1'.repeat(10)}.${'a'.repeat(64)}` });

describe('the follow-ups of an answer', () => {
  const answered = answerOf('shared', [nodeOf('widget', 'A-1'), nodeOf('widget', 'A-2'), nodeOf('gadget', 'A-3')]);
  const follow = (intents: readonly AskIntent[], answer: AskAnswer = answered) => followUpsOf({ answer, folder: folderOf(intents), sourceId: SOURCE, seal });

  it('gives each template intent after the answered one whose every role an element of the answer fills, a different element for each role, in the folder’s order', () => {
    const chips = follow([entityIntent('shared', 'widget'), queryIntent, entityIntent('widgetById', 'widget'), pairIntent('between', 'widget'), entityIntent('gadgetById', 'gadget')]);
    expect(chips.map((chip) => [chip.choice.intent, chip.choice.roles, chip.choice.entities, chip.titles])).toEqual([
      ['widgetById', ['id'], { id: 'A-1' }, ['Title A-1']],
      ['between', ['a', 'b'], { a: 'A-1', b: 'A-2' }, ['Title A-1', 'Title A-2']],
      ['gadgetById', ['id'], { id: 'A-3' }, ['Title A-3']],
    ]);
  });

  it('never gives a file query, the intent that was answered, or an intent a role of which no setting places or no element fits', () => {
    const unplaced: AskIntent = { name: 'loose', parameters: ['id'], kind: 'template', template: 'entity', settings: {} };
    expect(follow([entityIntent('shared', 'widget'), queryIntent, unplaced, entityIntent('missingType', 'sprocket'), pairIntent('needsTwoGadgets', 'gadget')])).toEqual([]);
  });

  it('gives none when the folder has no template intent that fits, and is not an error', () => {
    expect(follow([queryIntent])).toEqual([]);
    expect(followUpsOf({ answer: answered, folder: undefined, sourceId: SOURCE, seal })).toEqual([]);
  });

  it('gives at most the most an answer suggests', () => {
    const many = ['w1', 'w2', 'w3', 'w4', 'w5'].map((name) => entityIntent(name, 'widget'));
    expect(follow([entityIntent('shared', 'widget'), ...many]).map((chip) => chip.choice.intent)).toEqual(['w1', 'w2', 'w3']);
    expect(ASSISTANT_FOLLOW_UPS_MAX).toBe(3);
  });

  it('gives none for a heavy stop and none for a refusal', () => {
    expect(follow([entityIntent('widgetById', 'widget')], askAnswerSchema.parse({ answered: { intent: 'shared', entities: {}, outcome: 'partial', continueToken: `${'1'.repeat(10)}.${'a'.repeat(64)}`, result: heavyResult() } }))).toEqual([]);
    expect(follow([entityIntent('widgetById', 'widget')], refusal('no-ask-for-source'))).toEqual([]);
  });
});

describe('the follow-ups over the folders of the demo packs', () => {
  it.each(['banking-fraud', 'insurance-claims'])('each follow-up of the %s folder names a template intent of the folder and elements of the answer, each role filled once', async (pack) => {
    const root = mkdtempSync(join(tmpdir(), 'pack-folder-'));
    made.push(root);
    mkdirSync(join(root, SOURCE));
    for (const file of ['classification.md', 'intents.json']) copyFileSync(join(PACKS, pack, 'ask', file), join(root, SOURCE, file));
    const loaded = await loadAskFolder({ folder: root, sourceIds: [SOURCE] });
    if (!loaded.ok) throw new Error(loaded.problems.join('; '));
    const intents = loaded.folder.source(SOURCE)?.intents ?? [];
    const types = [...new Set(intents.flatMap((intent) => intent.parameters.flatMap((role) => roleEntityType(intent, role) ?? [])))];
    const nodes = types.flatMap((type) => [nodeOf(type, `${type}-1`), nodeOf(type, `${type}-2`)]);
    const first = intents.find((intent) => intent.kind === 'template');
    const chips = followUpsOf({ answer: answerOf(first?.name ?? 'x', nodes), folder: loaded.folder, sourceId: SOURCE, seal });
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.length).toBeLessThanOrEqual(ASSISTANT_FOLLOW_UPS_MAX);
    for (const chip of chips) {
      const intent = loaded.folder.intent(SOURCE, chip.choice.intent);
      expect(intent?.kind).toBe('template');
      expect([...chip.choice.roles].sort()).toEqual([...(intent?.parameters ?? [])].sort());
      const values = chip.choice.roles.map((role) => chip.choice.entities[role]);
      expect(new Set(values).size).toBe(values.length);
      for (const role of chip.choice.roles) {
        const node = nodes.find((held) => held.ref.stableId === chip.choice.entities[role]);
        expect(node?.ref.entityType).toBe(intent === undefined ? undefined : roleEntityType(intent, role));
      }
    }
  });
});
