import { describe, expect, it } from 'vitest';
import { HELP_LINKS, QUICKSTART_ANCHOR, REPOSITORY_URL } from './links.js';

const SAMPLE_REPOSITORY = 'https://repository.example/owner/name';
const published = (target: string): URL => new URL(target.replace(REPOSITORY_URL, SAMPLE_REPOSITORY));

describe('the help link targets', () => {
  it('builds every target from the one repository constant', () => {
    for (const target of Object.values(HELP_LINKS)) expect(target.startsWith(`${REPOSITORY_URL}/`) || target.startsWith(`${REPOSITORY_URL}#`)).toBe(true);
    expect(Object.values(HELP_LINKS).every((target) => target.split(REPOSITORY_URL).length === 2)).toBe(true);
  });

  it('holds the address of the public repository, as an https address with no trailing slash', () => {
    expect(REPOSITORY_URL).toBe('https://github.com/Neburyx/neburyx');
    expect(REPOSITORY_URL.endsWith('/')).toBe(false);
  });

  it.each(Object.entries(HELP_LINKS))('has %s as an https address with no query string once the repository address is put in', (_name, target) => {
    const url = published(target);
    expect(url.protocol).toBe('https:');
    expect(url.search).toBe('');
  });

  it('names the four places the menu points at and the install guide', () => {
    expect(HELP_LINKS).toEqual({
      documentation: `${REPOSITORY_URL}/tree/main/docs`,
      quickstart: `${REPOSITORY_URL}#quickstart`,
      enterprise: `${REPOSITORY_URL}/discussions`,
      problem: `${REPOSITORY_URL}/issues`,
      installGuide: `${REPOSITORY_URL}/blob/main/docs/install.md`,
    });
  });

  it('keeps the only fragment as the fixed Quickstart anchor', () => {
    expect(QUICKSTART_ANCHOR).toBe('quickstart');
    expect(Object.values(HELP_LINKS).filter((target) => published(target).hash !== '')).toEqual([HELP_LINKS.quickstart]);
  });
});
