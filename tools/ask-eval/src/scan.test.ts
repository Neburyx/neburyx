import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { runCli } from './cli.js';
import { insideGitTree } from './paths.js';
import { scanTree } from './scan.js';
import { cleanUp, fixtureSet, hooksWith, io, QUESTIONS, scratch } from './testing/hooks.js';

afterAll(cleanUp);

const LONG = 'This line of the classification text is long enough to count as a whole line.';

describe('scanning a tree for a private set', () => {
  const tree = (files: Record<string, string>) => {
    const root = scratch();
    for (const [name, text] of Object.entries(files)) {
      mkdirSync(join(root, name, '..'), { recursive: true });
      writeFileSync(join(root, name), text);
    }
    return root;
  };
  const input = { questions: ['Show thing one.', 'What is the weather?'], intentNames: ['byId', 'pair'], classification: `${LONG}\n{\n\`\`\`\nshort\n`, exclude: [] as string[], common: [] as string[] };

  it('counts a planted whole question, a planted intent name as a whole token and a planted long line, and nothing else', () => {
    const root = tree({ 'a/one.md': 'x Show thing one. y', 'b/two.ts': 'const a = byId;', 'c/three.txt': `${LONG}\n` });
    expect(scanTree(root, input)).toMatchObject({ questions: 1, intentNames: 1, lines: 1 });
  });

  it('does not count a short or generic line, a code fence, a part of an intent name or a question that is only part of a wording', () => {
    const root = tree({ 'a.md': '{\n```\nshort\nbyIdentity bypair my-byId pair_x\nShow thing\n' });
    expect(scanTree(root, input)).toMatchObject({ questions: 0, intentNames: 0, lines: 0 });
  });

  it('does not count a long line that a public file shares with the private text', () => {
    const root = tree({ 'a/one.md': `${LONG}\n`, 'public/reply.md': `${LONG}\n` });
    expect(scanTree(join(root, 'a'), { ...input, common: [join(root, 'public')] })).toMatchObject({ lines: 0, exempted: 1 });
    expect(scanTree(join(root, 'a'), input).lines).toBe(1);
  });

  it('refuses a common path that is the scanned tree or contains it, so the line check cannot be blinded', () => {
    const root = tree({ 'a/one.md': `${LONG}\n` });
    expect(() => scanTree(join(root, 'a'), { ...input, common: [join(root, 'a')] })).toThrow(/common path/);
    expect(() => scanTree(join(root, 'a'), { ...input, common: [root] })).toThrow(/common path/);
  });

  it('counts a file over 5 MiB as skipped, and the command is not clean then', () => {
    const root = tree({ 'big.txt': 'x'.repeat(5 * 1024 * 1024 + 1) });
    expect(scanTree(root, input).skipped).toBe(1);
  });

  it('leaves out the paths it is told to, the .git folder and node_modules', () => {
    const root = tree({ 'private/doc.md': 'Show thing one.', '.git/x': 'Show thing one.', 'node_modules/y/z.js': 'Show thing one.' });
    expect(scanTree(root, { ...input, exclude: [join(root, 'private')] }).questions).toBe(0);
  });
});

describe('the scan command', () => {
  const hooks = () => hooksWith(() => ({ failure: 'timeout' }));

  it('exits 0 for a clean tree and 1 for a tree that holds a question, printing counts only', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const clean = scratch();
    writeFileSync(join(clean, 'a.md'), 'nothing here');
    const run = io();
    expect(await runCli(['scan', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, clean], run.io, hooks())).toBe(0);
    expect(run.out).toEqual(['questions found: 0', 'intent names found: 0', 'classification lines found: 0', 'classification lines exempted as common: 0', 'files skipped (over 5 MiB): 0']);
    writeFileSync(join(clean, 'b.md'), 'we asked: What is the weather? once');
    const dirty = io();
    expect(await runCli(['scan', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, clean], dirty.io, hooks())).toBe(1);
    expect(dirty.out.join('\n')).toContain('questions found: 1');
    expect(dirty.out.join('\n')).not.toContain('weather');
  });

  it('leaves out a path given with --exclude', async () => {
    const fixture = fixtureSet(QUESTIONS);
    const tree = scratch();
    mkdirSync(join(tree, 'private'));
    writeFileSync(join(tree, 'private', 'doc.md'), 'What is the weather?');
    const run = io();
    expect(await runCli(['scan', '--questions', fixture.questions, '--folder', fixture.folder, '--source', fixture.source, '--exclude', join(tree, 'private'), tree], run.io, hooks())).toBe(0);
  });
});

describe('the git working tree rule', () => {
  it('finds a .git above a path that does not exist yet, and none above a fresh folder', () => {
    const root = scratch();
    expect(insideGitTree(join(root, 'not', 'yet'))).toBe(false);
    mkdirSync(join(root, '.git'));
    expect(insideGitTree(join(root, 'not', 'yet'))).toBe(true);
  });
});
