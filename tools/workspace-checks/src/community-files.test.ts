import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './workspace.js';

const read = (file: string) => readFileSync(join(repoRoot, file), 'utf8');
const security = read('SECURITY.md');
const prose = security.replace(/\s+/g, ' ');

describe('SECURITY.md', () => {
  it('names GitHub private vulnerability reporting by the tab and the button', () => {
    expect(prose).toContain("GitHub's private vulnerability reporting");
    expect(prose).toContain('**Security** tab');
    expect(prose).toContain('**Report a vulnerability**');
  });

  it('says not to report a vulnerability in public', () => {
    expect(prose).toContain('Do not open a public issue, discussion or pull request for a vulnerability');
  });

  it('says what to include and asks for synthetic data only', () => {
    expect(prose).toContain('Use synthetic data only');
  });

  it('promises no time and no number of supported versions', () => {
    expect(security).not.toMatch(/\d+\s*(hours?|days?|weeks?|months?)/i);
    expect(prose).toContain('no promise about how long each step takes');
  });

  it('holds no address and no link', () => {
    expect(security).not.toMatch(/@\S|https?:|www\./i);
  });
});

describe('the README', () => {
  it('links the contribution file and the security file by relative path', () => {
    const readme = read('README.md');
    expect(readme).toContain('](CONTRIBUTING.md)');
    expect(readme).toContain('](SECURITY.md)');
  });

  it('has both files at the repo root', () => {
    expect(() => read('CONTRIBUTING.md')).not.toThrow();
    expect(() => read('SECURITY.md')).not.toThrow();
  });
});
