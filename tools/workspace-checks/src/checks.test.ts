import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lintRuleIds, typecheck } from './checks.js';
import { repoRoot } from './workspace.js';

describe('type check', () => {
  it('reports a type error and names the file', () => {
    const result = typecheck(join(repoRoot, 'tools', 'workspace-checks', 'fixtures', 'type-error'));
    expect(result.exitCode).not.toBe(0);
    expect(result.output).toContain('index.ts');
  });
});

describe('lint rules', () => {
  it.each([
    ['explicit-any.ts', '@typescript-eslint/no-explicit-any'],
    ['non-null-assertion.ts', '@typescript-eslint/no-non-null-assertion'],
    ['ts-ignore.ts', '@typescript-eslint/ban-ts-comment'],
    ['console-log.ts', 'no-console'],
    ['explicit-any.tsx', '@typescript-eslint/no-explicit-any'],
    ['console-log.tsx', 'no-console'],
  ])('reports exactly the matching rule for %s', async (file, rule) => {
    expect(await lintRuleIds(file)).toEqual([rule]);
  });

  it('reports nothing for a clean fixture, in a .ts and in a .tsx file', async () => {
    expect(await lintRuleIds('clean.ts')).toEqual([]);
    expect(await lintRuleIds('clean.tsx')).toEqual([]);
  });

  it('counts a parse error as a diagnostic without a rule', async () => {
    expect(await lintRuleIds('parse-error.ts')).toEqual([null]);
  });
});
