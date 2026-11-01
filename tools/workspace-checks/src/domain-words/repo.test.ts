import { describe, expect, it } from 'vitest';
import { repoRoot } from '../workspace.js';
import { checkDomainWords } from './check.js';
import { formatWordViolations } from './violations.js';

describe('the repository', () => {
  it('holds no pack identifier as a string literal in the product directories', () => {
    expect(formatWordViolations(checkDomainWords(repoRoot))).toBe('');
  });
});
