import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PlannerModule } from './types.js';
import { createEvalPlanner } from '../../../ee/ask/dist/eval/replay-planner.js';
import { EXIT_MISS, EXIT_OK, EXIT_USAGE, runCli } from './cli.js';
import { countWordingHits } from './scan.js';

const ROOT = resolve(import.meta.dirname, '..', '..', '..');
const MAPPING = join(ROOT, 'domain-packs', 'banking-fraud', 'neburyx.yaml');
const PLANNER: PlannerModule = { createEvalPlanner };
const dirs: string[] = [];

const FILE = `questions:
  - id: show-one
    pack: banking-fraud
    wording: Show me ‹account#1›.
    expect: { kind: plan, template: entity, params: { ref: { entityType: account, stableId: ‹account#1› } } }
  - id: judge-one
    pack: banking-fraud
    wording: Is ‹account#1› fraudulent?
    expect: { kind: unsupported, family: judgement }
  - id: odd-one
    pack: banking-fraud
    wording: Which accounts use the zzxqv device as ‹account#1›?
    expect: { kind: blocked }
`;

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ask-eval-external-'));
  dirs.push(dir);
  return dir;
}

async function cli(args: readonly string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli([...args], { out: (line) => void out.push(line), err: (line) => void err.push(line) }, PLANNER);
  return { code, out, err };
}

async function externalRig(questions = FILE) {
  const dir = folder();
  const file = join(dir, 'questions.yaml');
  writeFileSync(file, questions);
  const replay = join(dir, 'replay.json');
  const args = ['--questions', file, '--replay', replay, '--mapping', MAPPING, '--refusal-target', 'exact', '--max-misses', '0'];
  const written = await cli([...args, '--write-replay', '--out', replay]);
  return { dir, file, replay, args, written };
}

afterAll(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe('a question file outside the checkout', () => {
  it('is scored with the same rules from a mapping and a replay at paths given, with targets from the arguments', async () => {
    const { args, written } = await externalRig();
    expect(written.code).toBe(EXIT_OK);
    const result = await cli(args);
    expect(result.code).toBe(EXIT_OK);
    expect(result.out.slice(0, 2)).toEqual(['refusals: 1 of 1 refused', 'plans: 1 of 1 right (at most 0 may miss)']);
  });

  it('reports a question that is expected to be blocked and is blocked outside both counts, by id', async () => {
    const { args } = await externalRig();
    const result = await cli(args);
    expect(result.out).toContain('blocked: 1 of 1 expected');
    expect(result.out.join('\n')).not.toContain('zzxqv');
  });

  it('fails the run when a question expected to be blocked is no longer blocked, by id only', async () => {
    const { args, replay } = await externalRig();
    const fixed = FILE.replace('Which accounts use the zzxqv device as ‹account#1›?', 'Which accounts use the same device as ‹account#1›?');
    writeFileSync(args[1] ?? '', fixed);
    const result = await cli(args);
    expect(result.code).toBe(EXIT_MISS);
    expect(result.out).toContain('not-blocked: odd-one');
    expect(result.out).toContain('target missed: every blocked question must be blocked');
    expect(readFileSync(replay, 'utf8')).toContain('"plan"');
  });

  it('counts a question that blocks and is not expected to as a miss of its target, by id only', async () => {
    const unexpected = FILE.replace('expect: { kind: blocked }', 'expect: { kind: plan, template: entity, params: { ref: { entityType: account, stableId: ‹account#1› } } }');
    const { args } = await externalRig(unexpected);
    const result = await cli(args);
    expect(result.code).toBe(EXIT_MISS);
    expect(result.out).toContain('blocked-unexpectedly: odd-one');
    expect(result.out.join('\n')).not.toContain('zzxqv');
  });

  it('writes no output unless --out names a path outside the checkout, and never to a path inside it', async () => {
    const { args, replay } = await externalRig();
    expect((await cli([...args, '--write-replay'])).code).toBe(EXIT_USAGE);
    expect((await cli([...args, '--write-replay', '--out', join(ROOT, 'replay.json')])).code).toBe(EXIT_USAGE);
    expect((await cli([...args, '--update-baseline', '--baseline', join(folder(), 'b.json')])).code).toBe(EXIT_USAGE);
    const outside = join(folder(), 'baseline.json');
    const updated = await cli([...args, '--baseline', outside, '--update-baseline', '--out', outside]);
    expect(updated.code).toBe(EXIT_OK);
    expect(JSON.parse(readFileSync(outside, 'utf8'))).toMatchObject({ modes: { replay: { plansRight: 1, refusalsRefused: 1 } } });
    expect(readFileSync(replay, 'utf8')).toContain('"plan"');
  });

  it('needs its own targets, one mapping and one pack', async () => {
    const { args } = await externalRig();
    const without = args.slice(0, args.indexOf('--refusal-target'));
    expect((await cli(without)).code).toBe(EXIT_USAGE);
    expect((await cli([...args, '--packs', join(ROOT, 'domain-packs')])).code).toBe(EXIT_USAGE);
    const two = await externalRig(FILE.replace('pack: banking-fraud\n    wording: Is', 'pack: insurance-claims\n    wording: Is'));
    expect((await cli(two.args)).code).toBe(EXIT_USAGE);
  });

  it('refuses a question file inside the checkout other than the demo file, before reading it', async () => {
    const inside = join(ROOT, 'tools', 'ask-eval', 'not-a-questions-file.yaml');
    const result = await cli(['--questions', inside, '--replay', join(folder(), 'r.json'), '--mapping', MAPPING, '--refusal-target', 'exact', '--max-misses', '0']);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join(' ')).toContain('inside the checkout');
  });

  it('says where a malformed file is wrong and never repeats a wording', async () => {
    const dir = folder();
    const file = join(dir, 'questions.yaml');
    writeFileSync(file, 'questions:\n  - id: Bad Id\n    wording: Secret words here.\n    expect: { kind: unsupported }\n');
    const result = await cli(['--questions', file, '--replay', join(dir, 'r.json'), '--mapping', MAPPING, '--refusal-target', 'exact', '--max-misses', '0']);
    expect(result.code).toBe(EXIT_USAGE);
    expect(result.err.join(' ')).toContain('line 2, field questions.0.id');
    expect(result.err.join(' ')).not.toContain('Secret');
  });
});

describe('the scan for a private question file', () => {
  const PLANTED = ['Which synthetic ledgers carry', 'the planted sentence', 'about harbours'].join(' ');
  const planted = `questions:\n  - id: planted-one\n    wording: ${PLANTED} ‹account#1›?\n    expect: { kind: unsupported }\n`;

  it('finds no wording in a tree that holds none, and finds one planted in it, and prints only a count', async () => {
    const privateDir = folder();
    const file = join(privateDir, 'questions.yaml');
    writeFileSync(file, planted);
    const tree = folder();
    mkdirSync(join(tree, 'docs'));
    writeFileSync(join(tree, 'docs', 'note.md'), 'Nothing of the file is here.');
    expect(countWordingHits(file, tree)).toBe(0);
    writeFileSync(join(tree, 'docs', 'leak.md'), `A copy: ${PLANTED} ‹account#7›?`);
    expect(countWordingHits(file, tree)).toBe(1);
    const result = await cli(['scan', '--questions', file, '--root', tree]);
    expect(result).toMatchObject({ code: EXIT_OK, out: ['1'] });
    expect(result.out.join('')).not.toContain(PLANTED);
  });

  it('finds none of the planted wording in the checked-in runner and its question folder', () => {
    const file = join(folder(), 'questions.yaml');
    writeFileSync(file, planted);
    expect(countWordingHits(file, join(ROOT, 'tools', 'ask-eval', 'src'))).toBe(0);
    expect(countWordingHits(file, join(ROOT, 'services', 'api', 'tests', 'ask'))).toBe(0);
  });
});
