import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { repoRoot, workspacePackageDirs } from './workspace.js';

const configText = readFileSync(join(repoRoot, 'knip.jsonc'), 'utf8');
const IGNORE_KEYS = ['ignore', 'ignoreIssues', 'ignoreDependencies', 'ignoreBinaries', 'ignoreUnresolved', 'ignoreMembers', 'ignoreExportsUsedInFile'];
const BLANKET_KEYS = ['ignoreExportsUsedInFile'];

function configLines(text: string): readonly string[] {
  return text.split('\n');
}

/** The workspace keys of the config, read from the text because the file has comments. */
function workspaceKeys(text: string): readonly string[] {
  const lines = configLines(text);
  const start = lines.findIndex((line) => /^ {2}"workspaces": \{/.test(line));
  const keys: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\}/.test(line)) break;
    const match = /^ {4}"([^"]+)": \{/.exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return keys;
}

/** Lines that ignore something and have no comment above them or above the group they open. */
function unreasonedIgnores(text: string): readonly string[] {
  const lines = configLines(text);
  const isComment = (line: string | undefined): boolean => line?.trim().startsWith('//') ?? false;
  const found: string[] = [];
  lines.forEach((line, index) => {
    const key = new RegExp(`^\\s*"(${IGNORE_KEYS.join('|')})":\\s*(\\{|\\[|.*)`).exec(line);
    if (!key) return;
    let above = index - 1;
    while (above >= 0 && lines[above]?.trim() === '') above -= 1;
    if (!isComment(lines[above])) found.push(`${index + 1}: ${line.trim()}`);
  });
  // An entry inside an ignoreIssues block is reasoned when the run of entries it belongs to starts under a comment or under the key.
  const issuesStart = lines.findIndex((line) => /^ {2}"ignoreIssues": \{/.test(line));
  if (issuesStart >= 0) {
    let previous = 'key';
    for (let index = issuesStart + 1; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      if (/^ {2}\}/.test(line)) break;
      if (line.trim() === '') {
        previous = 'blank';
      } else if (isComment(line)) {
        previous = 'comment';
      } else if (/^ {4}"/.test(line)) {
        if (previous === 'blank') found.push(`${index + 1}: ${line.trim()}`);
        previous = 'entry';
      }
    }
  }
  return found;
}

const blanketIgnores = (text: string): readonly string[] => BLANKET_KEYS.filter((key) => text.includes(`"${key}"`));

function runKnip(directory: string): { readonly exitCode: number; readonly output: string } {
  const result = spawnSync(join(repoRoot, 'node_modules', '.bin', 'knip'), ['--directory', directory, '--no-progress'], { encoding: 'utf8' });
  return { exitCode: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

describe('unused-code check config', () => {
  it('has a workspace entry for every package of the workspace, and the root', () => {
    const wanted = ['.', ...workspacePackageDirs().map((dir) => relative(repoRoot, dir))];
    const keys = workspaceKeys(configText);
    expect(wanted.filter((dir) => !keys.includes(dir))).toEqual([]);
  });

  it('names no workspace entry that has no package behind it', () => {
    const wanted = new Set(['.', ...workspacePackageDirs().map((dir) => relative(repoRoot, dir))]);
    expect(workspaceKeys(configText).filter((key) => !wanted.has(key))).toEqual([]);
  });

  it('gives every ignore a comment with its reason, and uses no blanket ignore', () => {
    expect(unreasonedIgnores(configText)).toEqual([]);
    expect(blanketIgnores(configText)).toEqual([]);
  });

  it('finds a package with no entry, an entry with no package, an ignore with no reason and a blanket ignore in text that has them', () => {
    const bare = '{\n  "workspaces": {\n    ".": {},\n    "gone": {}\n  },\n  "ignoreDependencies": ["x"],\n  "ignoreExportsUsedInFile": true\n}\n';
    expect(workspaceKeys(bare)).toEqual(['.', 'gone']);
    expect(unreasonedIgnores(bare)).toHaveLength(2);
    expect(blanketIgnores(bare)).toEqual(['ignoreExportsUsedInFile']);
    expect(unreasonedIgnores('{\n  // why\n  "ignoreDependencies": ["x"]\n}\n')).toEqual([]);
    expect(unreasonedIgnores('{\n  // why\n  "ignoreIssues": {\n    "a.ts": ["exports"],\n\n    "b.ts": ["types"]\n  }\n}\n')).toEqual(['6:     "b.ts": ["types"]'.replace(/\s+/, ' ')]);
  });

  it('exits non-zero and names the export when knip runs on a tree with an unused export', () => {
    const result = runKnip(join(repoRoot, 'tools', 'workspace-checks', 'fixtures', 'knip', 'unused-export'));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('neverCalled');
  });

  it('exits zero when knip runs on a tree with none', () => {
    expect(runKnip(join(repoRoot, 'tools', 'workspace-checks', 'fixtures', 'knip', 'clean')).exitCode).toBe(0);
  });

  it('runs knip in the root lint script after eslint', () => {
    const scripts = z.object({ scripts: z.record(z.string(), z.string()) }).parse(JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'))).scripts;
    expect(scripts['lint']).toBe('eslint . --max-warnings 0 && knip');
  });
});
