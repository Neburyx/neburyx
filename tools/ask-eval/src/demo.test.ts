import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { cleanUp, hooksWith, io, scratch } from './testing/hooks.js';

afterAll(cleanUp);

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PACKS = join(ROOT, 'domain-packs');
const REPLAY = join(ROOT, 'tools', 'ask-eval', 'data', 'replay.json');
const BASELINE = join(ROOT, 'tools', 'ask-eval', 'data', 'baseline.json');
const hooks = () => hooksWith(() => ({ failure: 'timeout' }));

describe('the demo set on the committed replay', () => {
  it('has a replay that is exactly what the tool writes from the expectations while the replay is scripted', async () => {
    const committed = JSON.parse(readFileSync(REPLAY, 'utf8')) as { note?: string };
    if (committed.note !== 'scripted') return;
    const out = join(scratch(), 'replay.json');
    expect(await runCli(['--packs', PACKS, '--write-replay', out], io().io, hooks())).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(REPLAY, 'utf8'));
  });

  it('meets its targets and its baseline, over all 35 questions of both packs', async () => {
    const run = io();
    expect(await runCli(['--packs', PACKS, '--replay', REPLAY, '--baseline', BASELINE], run.io, hooks()), run.out.join('\n')).toBe(0);
    expect(run.out.join('\n')).toMatch(/\(35 questions\)/);
    expect(run.out.join('\n')).toContain('result: pass');
  });

  it('holds no baseline value for a scripted replay, and the baseline file has the form the tool reads', () => {
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as { replay?: unknown };
    const replay = JSON.parse(readFileSync(REPLAY, 'utf8')) as { note?: string };
    if (replay.note === 'scripted') expect(baseline.replay).toBeUndefined();
  });
});

describe('the demo set after a change to a pack', () => {
  const copy = () => {
    const folder = join(scratch(), 'packs');
    cpSync(PACKS, folder, { recursive: true });
    return folder;
  };
  const run = async (packs: string) => {
    const result = io();
    return { code: await runCli(['--packs', packs, '--replay', REPLAY], result.io, hooks()), ...result };
  };

  it('is refused when an intent is renamed, naming the question that expects it', async () => {
    const packs = copy();
    const file = join(packs, 'banking-fraud', 'ask', 'intents.json');
    writeFileSync(file, readFileSync(file, 'utf8').replace('"show-an-account"', '"show-one-account"'));
    const result = await run(packs);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toMatch(/banking-fraud\/show-an-account expects an intent that the folder does not have/);
  });

  it('is refused as a stale replay when a classification text changes', async () => {
    const packs = copy();
    const file = join(packs, 'insurance-claims', 'ask', 'classification.md');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nOne more sentence.\n`);
    const result = await run(packs);
    expect(result.code).toBe(2);
    expect(result.err.join('\n')).toContain('recorded for another classification text of insurance-demo');
  });

  it('is refused when a pack has questions and no ask folder', async () => {
    const packs = copy();
    const { rmSync } = await import('node:fs');
    rmSync(join(packs, 'insurance-claims', 'ask'), { recursive: true });
    expect((await run(packs)).code).toBe(2);
  });

  it('fails when the replay answers a question wrongly', async () => {
    const replay = JSON.parse(readFileSync(REPLAY, 'utf8')) as { answers: Record<string, unknown> };
    const wording = 'Show me AC-0002000.';
    replay.answers[wording] = { reply: '{"intent":null,"entities":{}}' };
    const file = join(scratch(), 'replay.json');
    writeFileSync(file, JSON.stringify(replay));
    const result = io();
    expect(await runCli(['--packs', PACKS, '--replay', file], result.io, hooks())).toBe(0);
    for (const wording2 of ['Which accounts use DV-000010?', 'Show the latest transactions of AC-0002000.', 'Show the payments made to MR-0100.']) replay.answers[wording2] = { reply: '{"intent":null,"entities":{}}' };
    writeFileSync(file, JSON.stringify(replay));
    const worse = io();
    expect(await runCli(['--packs', PACKS, '--replay', file], worse.io, hooks())).toBe(1);
    expect(worse.out.join('\n')).toContain('no-intent');
  });
});
