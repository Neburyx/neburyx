import net from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { createEvalPlanner } from '../../../ee/ask/dist/eval/replay-planner.js';
import { EXIT_MISS, EXIT_OK, runCli } from './cli.js';
import { loadMapping } from './mapping-view.js';
import type { PlannerModule, Replay } from './types.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const MAPPING = join(ROOT, 'domain-packs', 'banking-fraud', 'neburyx.yaml');
const PLANNER: PlannerModule = { createEvalPlanner };
const dirs: string[] = [];

const account = { entityType: 'account', stableId: '‹account#1›' };
const planReply = (templateId: string, params: object): string => JSON.stringify({ kind: 'plan', templateId, templateVersion: 1, params, rationale: 'Because the question names it.' });
const refusal = JSON.stringify({ kind: 'unsupported', reason: 'No template answers it.' });

const SAME_DEVICE = `  - id: same-device
    wording: Which accounts use the same device as ‹account#1›?
    expect: { kind: plan, template: shared-attribute, params: { ref: { entityType: account, stableId: ‹account#1› }, attributeType: device, via: USES_DEVICE } }
`;
const SHOW_ENTITY = `  - id: show-entity
    wording: Show me ‹account#1›.
    expect: { kind: plan, template: entity, params: { ref: { entityType: account, stableId: ‹account#1› } } }
`;
const JUDGEMENT = `  - id: judgement
    wording: Is ‹account#1› fraudulent?
    expect: { kind: unsupported }
`;
const MONEY_OUT = `  - id: money-out
    wording: Which accounts has ‹account#1› transferred money to?
    expect: { kind: plan, template: linked-entities, params: { ref: { entityType: account, stableId: ‹account#1› }, targetType: account, via: [TRANSFERRED_TO], direction: out } }
`;
const QUESTIONS = `questions:\n${SAME_DEVICE}${SHOW_ENTITY}${JUDGEMENT}${MONEY_OUT}`;

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ask-eval-'));
  dirs.push(dir);
  return dir;
}


async function replayFor(wordings: Readonly<Record<string, { plan: string; repair?: string }>>): Promise<Replay> {
  const planner = await createEvalPlanner({ view: loadMapping(MAPPING).view, replay: {} });
  const replay: Record<string, { plan: string; repair?: string }> = {};
  for (const [wording, entry] of Object.entries(wordings)) {
    const text = planner.rebuild(wording);
    if (text === undefined) throw new Error(`blocked: ${wording}`);
    replay[text] = entry;
  }
  return replay;
}

async function run(replay: Replay, questions = QUESTIONS) {
  const dir = workspace();
  writeFileSync(join(dir, 'questions.yaml'), questions);
  writeFileSync(join(dir, 'replay.json'), JSON.stringify(replay));
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(['--questions', join(dir, 'questions.yaml'), '--replay', join(dir, 'replay.json'), '--mapping', MAPPING, '--max-misses', '0', '--refusal-target', 'exact'], { out: (line) => void out.push(line), err: (line) => void err.push(line) }, PLANNER);
  return { code, out, err };
}

afterEach(() => vi.restoreAllMocks());
afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('the runner over the real planner', () => {
  it('scores each question from its recorded reply and prints refusals and plans on two lines, with no socket opened', async () => {
    const connect = vi.spyOn(net.Socket.prototype, 'connect');
    const replay = await replayFor({
      'Which accounts use the same device as ‹account#1›?': { plan: planReply('shared-attribute', { ref: account, attributeType: 'device', via: 'USES_DEVICE' }) },
      'Show me ‹account#1›.': { plan: planReply('entity', { ref: account }) },
      'Is ‹account#1› fraudulent?': { plan: refusal },
      'Which accounts has ‹account#1› transferred money to?': { plan: planReply('linked-entities', { ref: account, targetType: 'account', via: ['TRANSFERRED_TO'], direction: 'out' }) },
    });
    const { code, out } = await run(replay);
    expect(code).toBe(EXIT_OK);
    expect(out.slice(0, 2)).toEqual(['refusals: 1 of 1 refused', 'plans: 3 of 3 right (at most 0 may miss)']);
    expect(connect).not.toHaveBeenCalled();
  });

  it('reports a question without a reply as no-reply and exits with a miss', async () => {
    const replay = await replayFor({ 'Show me ‹account#1›.': { plan: planReply('entity', { ref: account }) } });
    const { code, out } = await run(replay);
    expect(code).toBe(EXIT_MISS);
    expect(out).toContain('no-reply: same-device');
    expect(out).toContain('no-reply: judgement');
  });

  it('uses the repair reply when the first reply is invalid and counts it', async () => {
    const replay = await replayFor({ 'Show me ‹account#1›.': { plan: 'not a plan', repair: planReply('entity', { ref: account }) } });
    const { out } = await run(replay, `questions:\n${SHOW_ENTITY}`);
    expect(out).toContain('repaired: 1');
    expect(out[1]).toBe('plans: 1 of 1 right (at most 0 may miss)');
  });

  it('reports an invalid reply with no repair reply as no-reply for the repair', async () => {
    const replay = await replayFor({ 'Show me ‹account#1›.': { plan: 'not a plan' } });
    const only = `questions:\n${SHOW_ENTITY}`;
    const { code, out } = await run(replay, only);
    expect(code).toBe(EXIT_MISS);
    expect(out).toContain('no-reply: show-entity');
  });

  it('scores a plan that omits a direction the mapping gives as right, and one that omits a limit as right', async () => {
    const replay = await replayFor({ 'Which accounts has ‹account#1› transferred money to?': { plan: planReply('linked-entities', { ref: account, targetType: 'account', via: ['TRANSFERRED_TO'] }) } });
    const only = `questions:\n${MONEY_OUT}`;
    const { out } = await run(replay, only);
    expect(out.slice(0, 2)).toEqual(['refusals: 0 of 0 refused', 'plans: 1 of 1 right (at most 0 may miss)']);
  });

  it('reports a wording the allowlist blocks by id, never by its tokens', async () => {
    const blocked = `questions:\n  - id: odd-word\n    wording: Which accounts use the zzxqv device as ‹account#1›?\n    expect: { kind: plan, template: entity, params: { ref: { entityType: account, stableId: ‹account#1› } } }\n`;
    const { code, out } = await run({}, blocked);
    expect(code).toBe(EXIT_MISS);
    expect(out).toContain('blocked-unexpectedly: odd-word');
    expect(out.join('\n')).not.toContain('zzxqv');
  });
});
