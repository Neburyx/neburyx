import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './workspace.js';
import { ALL_GUARDED, lockVersions, pinProblems, recordProblems, updateRecord } from './tool-guard-versions.js';

const lockPath = join(repoRoot, 'pnpm-lock.yaml');
const recordPath = join(repoRoot, 'ee', 'assistant-agent', 'tool-guard-versions.json');
const packagePath = join(repoRoot, 'ee', 'assistant-agent', 'package.json');

const lockOf = (versions: Record<string, string[]>): string =>
  `lockfileVersion: '9.0'\n\npackages:\n\n${Object.entries(versions).flatMap(([name, list]) => list.map((version) => `  ${name.startsWith('@') ? `'${name}@${version}'` : `${name}@${version}`}:\n    resolution: {integrity: x}\n`)).join('\n')}\nsnapshots:\n\n  deepagents@9.9.9(x):\n    dependencies: {}\n`;
const same = Object.fromEntries(ALL_GUARDED.map((name) => [name, '1.0.0']));

describe('the guard of the versions of deepagents and LangChain', () => {
  it('fails a package that resolves to another version than the record, naming the package and both versions', () => {
    expect(recordProblems(same, lockOf({ ...Object.fromEntries(ALL_GUARDED.map((name) => [name, ['1.0.0']])), langsmith: ['2.0.0'] }))).toEqual([
      expect.stringContaining('langsmith: recorded 1.0.0, resolved 2.0.0 in pnpm-lock.yaml; run the guarded suites and the update mode'),
    ]);
  });

  it('fails a peer that moves in the lockfile alone, and one that resolves to two versions or to none', () => {
    const base = Object.fromEntries(ALL_GUARDED.map((name) => [name, ['1.0.0']]));
    expect(recordProblems(same, lockOf({ ...base, '@langchain/langgraph': ['1.0.1'] }))[0]).toContain('@langchain/langgraph: recorded 1.0.0, resolved 1.0.1');
    expect(recordProblems(same, lockOf({ ...base, langsmith: ['1.0.0', '1.0.1'] }))[0]).toContain('langsmith resolves to 1.0.0 and 1.0.1');
    const missing = { ...base } as Record<string, string[]>;
    delete missing['deepagents'];
    expect(recordProblems(same, lockOf(missing))[0]).toContain('deepagents resolves to no version');
  });

  it('passes when the record matches what the lockfile resolves, and reads only the packages block', () => {
    const lock = lockOf(Object.fromEntries(ALL_GUARDED.map((name) => [name, ['1.0.0']])));
    expect(recordProblems(same, lock)).toEqual([]);
    expect(lockVersions(lock).get('deepagents')).toEqual(['1.0.0']);
  });

  it('fails a range in the package file, for each of the five direct packages, and passes the exact versions', () => {
    const file = (ranges: Record<string, string>) => JSON.stringify({ dependencies: ranges });
    const exact = { deepagents: '1.17.0', langchain: '1.6.7', '@langchain/core': '1.5.0', '@langchain/anthropic': '1.6.6', '@langchain/openai': '1.8.5' };
    expect(pinProblems(file(exact))).toEqual([]);
    for (const name of Object.keys(exact)) expect(pinProblems(file({ ...exact, [name]: `^${exact[name as keyof typeof exact]}` }))).toEqual([`${name} is "^${exact[name as keyof typeof exact]}" in ee/assistant-agent/package.json: pin an exact version`]);
    expect(pinProblems(file({}))).toHaveLength(5);
  });

  it('update mode leaves the record unchanged when a guarded suite fails, and writes the resolved versions when all passed', () => {
    const lock = lockOf(Object.fromEntries(ALL_GUARDED.map((name) => [name, ['2.0.0']])));
    const written: string[] = [];
    expect(updateRecord({ suitesPassed: () => false, lockText: lock, write: (text) => written.push(text) })).toBe(false);
    expect(written).toEqual([]);
    expect(updateRecord({ suitesPassed: () => true, lockText: lock, write: (text) => written.push(text) })).toBe(true);
    expect((JSON.parse(written[0] ?? '') as { versions: Record<string, string> }).versions['deepagents']).toBe('2.0.0');
  });

  it('holds on the real repository: exact pins in the package file, and a record that matches the lockfile', () => {
    expect(pinProblems(readFileSync(packagePath, 'utf8'))).toEqual([]);
    const record = (JSON.parse(readFileSync(recordPath, 'utf8')) as { versions: Record<string, string> }).versions;
    expect(recordProblems(record, readFileSync(lockPath, 'utf8'))).toEqual([]);
  });

  it.skipIf(process.env['NBX_UPDATE_TOOL_GUARD'] !== '1')('update mode on the repository: runs the guarded suites, then writes the record', () => {
    const run = (args: string[]) => spawnSync('pnpm', args, { cwd: repoRoot, stdio: 'inherit' }).status === 0;
    const suitesPassed = () => run(['--filter', '@neburyx/ee-assistant-agent', 'test']) && run(['--filter', '@neburyx/ee-ask', 'exec', 'vitest', 'run', 'src/assistant/tool-allowlist.test.ts', 'src/assistant/answer-only.test.ts', 'src/assistant/agent-turn.test.ts']);
    expect(updateRecord({ suitesPassed, lockText: readFileSync(lockPath, 'utf8'), write: (text) => writeFileSync(recordPath, text) }), 'a guarded suite failed: the record is left unchanged').toBe(true);
  });
});
