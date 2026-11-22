// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HELP_LINKS, QUICKSTART_ANCHOR, REPOSITORY_URL, STYLE_RULES_GUIDE } from './links.js';

const SAMPLE_REPOSITORY = 'https://repository.example/owner/name';
const published = (target: string): URL => new URL(target.replace(REPOSITORY_URL, SAMPLE_REPOSITORY));
const { enterprise, ...REPOSITORY_LINKS } = HELP_LINKS;

/** An https address, or `mailto:` and one plain address: the two forms the Enterprise-interest target may take. */
function isInterestTarget(value: string): boolean {
  if (value.startsWith('mailto:')) return /^mailto:[^\s@?,;]+@[^\s@?,;]+\.[^\s@?,;]+$/.test(value);
  try {
    return new URL(value).protocol === 'https:' && !/\s/.test(value);
  } catch {
    return false;
  }
}

describe('the help link targets', () => {
  it('builds every target from the one repository constant', () => {
    for (const target of Object.values(REPOSITORY_LINKS)) expect(target.startsWith(`${REPOSITORY_URL}/`) || target.startsWith(`${REPOSITORY_URL}#`)).toBe(true);
    expect(Object.values(REPOSITORY_LINKS).every((target) => target.split(REPOSITORY_URL).length === 2)).toBe(true);
  });

  it('holds the address of the public repository, as an https address with no trailing slash', () => {
    expect(REPOSITORY_URL).toBe('https://github.com/Neburyx/neburyx');
    expect(REPOSITORY_URL.endsWith('/')).toBe(false);
  });

  it.each(Object.entries(REPOSITORY_LINKS))('has %s as an https address with no query string once the repository address is put in', (_name, target) => {
    const url = published(target);
    expect(url.protocol).toBe('https:');
    expect(url.search).toBe('');
  });

  it('names the places the menu points at and the install guide', () => {
    expect(REPOSITORY_LINKS).toEqual({
      documentation: `${REPOSITORY_URL}/tree/main/docs`,
      quickstart: `${REPOSITORY_URL}#quickstart`,
      problem: `${REPOSITORY_URL}/issues`,
      installGuide: `${REPOSITORY_URL}/blob/main/docs/install.md`,
    });
  });

  it('keeps the only fragment as the fixed Quickstart anchor', () => {
    expect(QUICKSTART_ANCHOR).toBe('quickstart');
    expect(Object.values(REPOSITORY_LINKS).filter((target) => published(target).hash !== '')).toEqual([HELP_LINKS.quickstart]);
  });
});

describe('the link to the style rules section of the mapping guide', () => {
  it('is built from the repository address and names the guide and its section, with no query string', () => {
    expect(STYLE_RULES_GUIDE).toBe(`${REPOSITORY_URL}/blob/main/docs/mapping-guide.md#style-rules`);
    expect(published(STYLE_RULES_GUIDE).search).toBe('');
  });
});

describe('the Enterprise-interest target', () => {
  it('is an https address or one plain mailto address', () => {
    expect(isInterestTarget(enterprise)).toBe(true);
  });

  it.each([
    ['an https address', 'https://example.test/inquiries'],
    ['a mailto address', 'mailto:inquiries@example.test'],
  ])('accepts %s', (_name, value) => {
    expect(isInterestTarget(value)).toBe(true);
  });

  it.each([
    ['an http address', 'http://example.test/inquiries'],
    ['a javascript address', 'javascript:alert(1)'],
    ['a data address', 'data:text/html,hello'],
    ['an address with no scheme', 'inquiries@example.test'],
    ['a mailto address with a query', 'mailto:inquiries@example.test?subject=hello'],
    ['a mailto address with two addresses', 'mailto:one@example.test,two@example.test'],
    ['a mailto address with a space', 'mailto:inquiries @example.test'],
    ['an empty value', ''],
  ])('refuses %s', (_name, value) => {
    expect(isInterestTarget(value)).toBe(false);
  });
});

describe('the one place that holds the Enterprise-interest target', () => {
  const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url));
  const files = (folder: string): string[] => readdirSync(folder, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? files(join(folder, entry.name)) : [join(folder, entry.name)]));
  const exempt = [join(SOURCE_ROOT, 'help', 'links.ts')];

  it('is held as a string by help/links.ts only: every other file of apps/web/src takes it from the constant', () => {
    const holding = files(SOURCE_ROOT).filter((file) => !exempt.includes(file) && readFileSync(file, 'utf8').includes(enterprise));
    expect(holding).toEqual([]);
  });

  it('is read by the Help menu and the Sources page from the constant, not copied', () => {
    expect(readFileSync(join(SOURCE_ROOT, 'help', 'help-items.ts'), 'utf8')).toContain('HELP_LINKS.enterprise');
    expect(readFileSync(join(SOURCE_ROOT, 'sources', 'enterprise-link.tsx'), 'utf8')).toContain('HELP_LINKS.enterprise');
  });
});

describe('the Enterprise link of the README', () => {
  const README = fileURLToPath(new URL('../../../../README.md', import.meta.url));
  const RENDERED_AT = `${REPOSITORY_URL}/blob/main/README.md`;
  const enterpriseTargetOf = (text: string): string | undefined => /\[Talk to us about Enterprise\]\(([^)\s]+)\)/.exec(text.slice(text.indexOf('## Questions and problems')))?.[1];
  const resolvesTo = (target: string | undefined, value: string): boolean => target !== undefined && new URL(target, RENDERED_AT).href === new URL(value).href;

  it('points where the Help menu does, read the way GitHub renders the README', () => {
    expect(resolvesTo(enterpriseTargetOf(readFileSync(README, 'utf8')), enterprise)).toBe(true);
  });

  it('fails for a README target that differs, a missing one, and a changed constant', () => {
    const readme = '## Questions and problems\n- [Talk to us about Enterprise](../../issues)\n';
    expect(resolvesTo(enterpriseTargetOf(readme), enterprise)).toBe(false);
    expect(resolvesTo(enterpriseTargetOf('## Questions and problems\n'), enterprise)).toBe(false);
    expect(resolvesTo('../../discussions', 'mailto:inquiries@example.test')).toBe(false);
    expect(resolvesTo('mailto:inquiries@example.test', 'mailto:inquiries@example.test')).toBe(true);
    expect(resolvesTo('../../discussions', `${REPOSITORY_URL}/discussions`)).toBe(true);
  });
});
