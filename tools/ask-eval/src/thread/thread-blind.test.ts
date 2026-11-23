import { mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blindSets, leakIn, permutationOf, type ArmRepeat } from './blind.js';
import { runCli } from '../cli.js';
import type { EvalHooks } from '../hooks.js';
import type { RepeatFile } from './driver.js';
import type { EnrichedRepeat } from './enrich.js';
import type { TurnRecords } from './records.js';

const answer = (text: string, cites: string[] = ['n1']) => ({ status: 'answered', route: 'view', sentences: [{ text, cites }], coverage: { retrieval: '1 shown · exact', summary: 'The answer cites 1 of the 1 elements.' } });
const records = (key: string, line: string): TurnRecords => ({ traceId: 't', run: { id: 'run-id-1', outcome: 'ok', finished: true, calls: 2, settings: {} }, calls: [{ number: 2, startedAt: '', durationMs: 1, status: 'answered', failureKind: null, errorClass: null, errorCode: null, tokensIn: 1, tokensOut: 1, instructionsSha256: 'sha-x', instructionsText: '', valuesText: `human: Question:\nq\ntool: Keys are renumbered.\n${key} | ${line}`, replyText: '[{"type":"tool_use","id":"x","name":"answer","input":{}}]', toolsOffered: null }], events: [], summaryCalls: 0, summaryUsage: [], reconciled: undefined, problems: [] });
function repeatOf(arm: string, repeat: number, turns: { message: string; answer: unknown; status?: 'answered' | 'failed'; trace?: string }[], expected: readonly string[] = turns.map((turn) => turn.message), sha = 'abc'): ArmRepeat {
  const file: RepeatFile = {
    manifest: { name: 'private-manifest-name', sha256: sha },
    sourceId: 'demo',
    repeat,
    expectedMessages: expected,
    arm,
    head: 'headsha1',
    settings: { model: 'model-secret-name', callLimit: 7, configured: {} },
    startedAt: '',
    endedAt: '',
    view: { entities: 26 },
    turns: turns.map((turn, index) => ({ n: index + 1, message: turn.message, traceId: turn.trace ?? `trace-${arm}-${repeat}-${index + 1}`, ms: 1, httpStatus: 200, status: turn.status ?? 'answered', answer: turn.answer })),
    ended: 'complete',
  };
  const lineOf = (index: number) => `line of ${arm === 'arm-refs' ? 'zulu' : 'yankee'} turn ${index + 1}`;
  const gate = { gated: { verdict: 'passed' as const, reads: 0, gateEvents: 0, failedEvents: 0 }, called: { verdict: 'passed' as const, names: [], outside: [], unparsed: 0 }, offered: { verdict: 'passed' as const, names: [], outside: [], callsWithoutNames: 0 } };
  const enriched: EnrichedRepeat = { file, records: turns.map((_, index) => records('n1', lineOf(index))), evidence: turns.map((_, index) => ({ citations: { callNumber: 2, mapped: [['n1', `n1 | ${lineOf(index)}`] as const], missing: [], malformed: 0 }, gate })), inconsistent: false, disagreeing: [] };
  return { arm, repeat, enriched };
}
const TURNS = [{ message: 'first question', answer: answer('Alpha is in view.') }, { message: 'second question', answer: answer('Beta is in view.') }];
const FORBIDDEN = ['arm-refs', 'arm-text', 'private-manifest-name', 'model-secret-name', 'headsha1'];
const options = (seed = 'seed-one') => ({ seed, manifestSha256: 'abc', forbidden: FORBIDDEN });

describe('the blind sets', () => {
  it('fails the leak check on a set that holds an arm name, a trace id or a model name, naming only the length of the text', () => {
    expect(leakIn('an answer by arm-refs', FORBIDDEN)).toBe('arm-refs');
    expect(leakIn('nothing identifying', FORBIDDEN)).toBeUndefined();
    const leaky = repeatOf('arm-refs', 1, [{ message: 'q', answer: answer('Gamma, written with model-secret-name.') }]);
    expect(() => blindSets([leaky], options())).toThrow('a blind set of repeat 1 holds identifying text');
    expect(() => blindSets([leaky], options())).not.toThrow('model-secret-name');
  });

  it('writes one set per repeat with the message, the answer, the cited line, the coverage and the answer\'s own earlier turns, and no arm, id or model name', () => {
    const output = blindSets([repeatOf('arm-refs', 1, TURNS), repeatOf('arm-text', 1, TURNS)], options());
    const set = output.sets.get(1) ?? '';
    expect(set).toContain('Message: second question');
    expect(set).toContain('Cited line n1: n1 | line of');
    expect(set).toContain('Coverage: 1 shown · exact | The answer cites 1 of the 1 elements.');
    expect(set).toContain("Earlier in this answerer's thread:");
    expect(leakIn(set, [...FORBIDDEN, 'trace-arm-refs', 'trace-arm-text'])).toBeUndefined();
    // each label's history is its own arm's: the line of the arm that wrote turn 2 of a label never appears under the other label's history
    const blocks = set.split('### Answer ').slice(1);
    for (const block of blocks) {
      const arms = [...block.matchAll(/line of (zulu|yankee)\b/gu)].map((match) => match[1]);
      expect(new Set(arms).size).toBeLessThanOrEqual(1);
    }
  });

  it('is the same for the same seed, draws the permutation of each turn from the seed, and with one arm holds that arm in turn order', () => {
    const inputs = [repeatOf('arm-refs', 1, TURNS), repeatOf('arm-text', 1, TURNS)];
    const a = blindSets(inputs, options('s'));
    const b = blindSets(inputs, options('s'));
    expect(b.sets.get(1)).toBe(a.sets.get(1));
    expect(JSON.stringify(b.key)).toBe(JSON.stringify(a.key));
    expect(permutationOf(['x', 'y', 'z'], (() => { let n = 0; return () => [0.9, 0.1, 0.5][n++ % 3] ?? 0; })())).toEqual(['y', 'x', 'z']);
    const one = blindSets([repeatOf('arm-refs', 1, TURNS)], options());
    expect(one.key.entries.map((entry) => entry.labels)).toEqual([{ A: 'arm-refs' }, { A: 'arm-refs' }]);
    expect(one.slots).toHaveLength(2);
  });

  it('puts a failed turn and a turn never run in as no answer, so every repeat has all its expected slots, also when every repeat stopped early', () => {
    const expected = ['q1', 'q2', 'q3'];
    const failed = repeatOf('arm-refs', 1, [{ message: 'q1', answer: answer('Alpha is in view.') }, { message: 'q2', answer: { status: 'unavailable' }, status: 'failed' }], expected);
    const short = repeatOf('arm-text', 1, [{ message: 'q1', answer: { status: 'unavailable' }, status: 'failed' }], expected);
    const output = blindSets([failed, short], options());
    const set = output.sets.get(1) ?? '';
    expect(set.match(/\(no answer: this turn did not run or did not give an answer\)/gu)?.length).toBe(5);
    expect(output.slots).toHaveLength(6);
    const none = blindSets([repeatOf('arm-refs', 1, [], expected), repeatOf('arm-text', 1, [], expected)], options());
    expect(none.slots).toHaveLength(6);
  });

  it('refuses a run given twice, a run of another manifest or of other messages, a run that is not the repeat it says, and a missing arm or repeat', () => {
    const one = repeatOf('arm-refs', 1, TURNS);
    expect(() => blindSets([one, one, repeatOf('arm-text', 1, TURNS)], options())).toThrow(/given twice/u);
    expect(() => blindSets([one, repeatOf('arm-text', 1, TURNS, undefined, 'other')], options())).toThrow(/another manifest/u);
    expect(() => blindSets([one, repeatOf('arm-text', 1, TURNS, ['x', 'y'])], options())).toThrow(/other messages/u);
    expect(() => blindSets([one, { ...repeatOf('arm-text', 1, TURNS), repeat: 2 }], options())).toThrow(/says arm arm-text repeat 1/u);
    expect(() => blindSets([one, repeatOf('arm-text', 2, TURNS)], options())).toThrow(/is missing/u);
    expect(() => blindSets([], options())).toThrow(/no run/u);
  });

  it('takes the coverage formats the product writes as they are, with nothing added: no count to find, a text of the ask route, no coverage for a refusal or an ask answer without one', () => {
    const shown = (coverage: unknown, route = 'view') => blindSets([repeatOf('arm-refs', 1, [{ message: 'q', answer: { ...answer('Alpha.'), route, coverage } }]), repeatOf('arm-text', 1, [{ message: 'q', answer: answer('Beta.') }])], options()).sets.get(1) ?? '';
    expect(shown({ retrieval: 'read 1, typology: 2 lines', summary: 'The answer cites 0 of 2.' })).toContain('Coverage: read 1, typology: 2 lines | The answer cites 0 of 2.');
    expect(shown({ retrieval: 'nothing found', summary: 'none', summaryCited: 'two sentences of the summary' })).toContain('Coverage: nothing found | none | two sentences of the summary');
    expect(shown('one text of the ask route', 'ask')).toContain('Coverage: one text of the ask route');
    expect(shown(undefined, 'ask')).toContain('Coverage: (none)');
  });

  it('scores a response that is not an answer as no answer: nothing to score, no point, and the slot is recorded in the key', () => {
    const output = blindSets([repeatOf('arm-refs', 1, [{ message: 'q', answer: { status: 'not-answered', sentence: 'x' } }]), repeatOf('arm-text', 1, [{ message: 'q', answer: answer('Beta.') }])], options());
    expect(output.key.noAnswer).toHaveLength(1);
    expect(output.sets.get(1)).toContain('(no answer: this turn did not run or did not give an answer)');
  });

  it('writes every coverage line in one neutral form, and fails naming the turn when a coverage line cannot be made neutral', () => {
    const odd = { ...answer('Alpha is in view.'), coverage: { retrieval: '6  shown • all types 184,533 (lowerBound)', summary: 'Cites 1 of 1.' } };
    const set = blindSets([repeatOf('arm-refs', 1, [{ message: 'q', answer: odd }]), repeatOf('arm-text', 1, [{ message: 'q', answer: answer('Beta.') }])], options()).sets.get(1) ?? '';
    expect(set).toContain('Coverage: 6 shown · all types 184,533 (lowerBound) | Cites 1 of 1.');
    for (const coverage of [undefined, { retrieval: 7, summary: 'x' }, {}]) {
      const bad = { ...answer('Alpha.'), coverage };
      expect(() => blindSets([repeatOf('arm-refs', 1, [{ message: 'q', answer: bad }]), repeatOf('arm-text', 1, [{ message: 'q', answer: answer('Beta.') }])], options())).toThrow(/repeat 1 turn 1 of arm arm-refs: the coverage lines/u);
    }
  });
});

describe('the blind command', () => {
  it('writes the sets and the key to different folders with mode 0600, and no set refers to the key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'thread-blind-'));
    const files = ['arm-refs', 'arm-text'].map((arm) => {
      const path = join(dir, `${arm}-r1.records.json`);
      writeFileSync(path, JSON.stringify(repeatOf(arm, 1, TURNS).enriched));
      return path;
    });
    const out: string[] = [];
    const code = await runCli(['thread', 'blind', '--seed', 's', '--sets', join(dir, 'sets'), '--key-folder', join(dir, 'key'), ...files], { out: (line) => out.push(line), err: () => undefined, env: {} }, {} as unknown as EvalHooks);
    expect(code).toBe(0);
    expect(readdirSync(join(dir, 'sets'))).toEqual(['set-1.md']);
    expect(readdirSync(join(dir, 'key'))).toEqual(['key.json']);
    expect(statSync(join(dir, 'key', 'key.json')).mode & 0o777).toBe(0o600);
    const set = readFileSync(join(dir, 'sets', 'set-1.md'), 'utf8');
    expect(set).not.toMatch(/key\.json|seed|"labels"/u);
    const same = await runCli(['thread', 'blind', '--seed', 's', '--sets', join(dir, 'sets'), '--key-folder', join(dir, 'sets'), ...files], { out: () => undefined, err: () => undefined, env: {} }, {} as unknown as EvalHooks);
    expect(same).toBe(2);
  });
});
