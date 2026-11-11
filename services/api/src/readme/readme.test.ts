import { describe, expect, it } from 'vitest';
import { Doc, REPOSITORY_ROOT } from '../testing/doc.js';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const readme = new Doc('README.md');
const rules = new Doc('CLAUDE.md');

const NOT_FILES = ['../../discussions', '../../issues'];
const COMMAND_PATTERN = /docker compose up|docker run|pnpm dev/;

describe('the README opens as a first-time evaluator needs', () => {
  it('has no pre-release status line and says what Neburyx is, who it is for and what it does', () => {
    const lower = readme.text.toLowerCase();
    expect(lower).not.toContain('pre-release');
    expect(lower).not.toContain('no product features');
    const opening = readme.lines.slice(0, readme.lines.findIndex((line) => line.startsWith('## ')) + 1).join('\n').toLowerCase();
    expect(opening).toContain('graph investigation workbench');
    expect(opening).toContain('existing neo4j');
    expect(opening).toContain('analysts');
    const does = readme.text.slice(readme.text.indexOf('## What it does\n'), readme.text.indexOf('## What it does not do')).toLowerCase();
    for (const phrase of ['bounded', 'readable network', 'source evidence', 'very many links', 'exact, estimated, a lower bound or unknown']) expect(does).toContain(phrase);
  });

  it('says what it does not do, with the one opt-in write', () => {
    const section = readme.text.slice(readme.text.indexOf('## What it does not do'), readme.text.indexOf('## Warning')).toLowerCase();
    for (const phrase of ['only reads', 'read-only login', '--write-probe', 'always rolled back', 'test environment', 'no query text reaches your database', 'no sign-in']) expect(section).toContain(phrase);
  });
});

describe('the warning comes before any command that starts the app or opens a port', () => {
  const warning = readme.headings().find((heading) => heading.text.startsWith('Warning'));

  it('names the loopback address, the missing sign-in and the rule', () => {
    expect(warning).toBeDefined();
    const start = warning?.line ?? 0;
    const next = readme.headings().find((heading) => heading.line > start);
    const section = readme.lines.slice(start, (next?.line ?? readme.lines.length + 1) - 1).join(' ').replace(/\s+/g, ' ').toLowerCase();
    expect(section).toContain('127.0.0.1');
    expect(section).toContain('no sign-in');
    expect(section).toContain('do not change the published address');
    expect(section).toContain('do not put the app on a network');
  });

  it('is above every fenced block that holds docker compose up, docker run or pnpm dev', () => {
    const blocks = readme.blocks().filter((block) => COMMAND_PATTERN.test(block.text));
    const offending = blocks.filter((block) => warning === undefined || block.line < warning.line).map((block) => block.line);
    expect(offending).toEqual([]);
  });
});

describe('the links of the README', () => {
  const links = readme.links();
  const relative = links.filter((link) => !/^[a-z]+:/.test(link.target) && !NOT_FILES.includes(link.target));

  it.each(relative.map((link) => [link.target, link.line] as const))('resolve: %s (line %i)', (target) => {
    const resolved = readme.resolveLink(target);
    expect(resolved.exists).toBe(true);
    expect(resolved.anchorFound).toBe(true);
  });

  it('include the docs a first-time reader needs', () => {
    const targets = links.map((link) => link.target);
    for (const required of ['docs/mapping-guide.md', 'docs/run-locally.md', 'docs/README.md', 'domain-packs/README.md', 'deploy/compose/README.md']) expect(targets).toContain(required);
  });

  it('carry the questions and problems links once each, to the pages of the repository itself, and no other doc carries them', () => {
    const discussions = links.filter((link) => link.text.includes('GitHub Discussions'));
    const issues = links.filter((link) => link.text.includes('GitHub Issues'));
    expect(discussions.map((link) => link.target)).toEqual(['../../discussions']);
    expect(issues.map((link) => link.target)).toEqual(['../../issues']);
    const section = readme.text.slice(readme.text.indexOf('## Questions and problems'));
    expect(section).toContain('talking to us about Enterprise');
    for (const name of readdirSync(join(REPOSITORY_ROOT, 'docs')).filter((file) => file.endsWith('.md'))) {
      const text = new Doc(`docs/${name}`).text;
      expect(text).not.toContain('../../discussions');
      expect(text).not.toContain('../../issues');
    }
  });
});

describe('the rest of the README', () => {
  it('lists only paths that exist in its layout table', () => {
    const start = readme.lines.indexOf('## Layout');
    const rows = readme.lines.slice(start).filter((line) => /^\| `/.test(line)).map((line) => /^\| `([^`]+)`/.exec(line)?.[1] ?? '');
    expect(rows.length).toBeGreaterThan(5);
    const missing = rows.filter((path) => !existsSync(join(REPOSITORY_ROOT, path)));
    expect(missing).toEqual([]);
  });

  it('keeps the licence line and the synthetic-data statement', () => {
    expect(readme.text).toContain('**Licence:** Apache-2.0 (see [LICENSE](LICENSE) and [NOTICE](NOTICE)).');
    expect(readme.text).toContain('uses synthetic data only');
  });

  it('gives development commands that are the build commands of the contributor guidance', () => {
    const block = readme.blocks().find((candidate) => candidate.heading === 'Development' && candidate.info === 'bash');
    const commands = (block?.text ?? '').split('\n').filter((line) => line.trim() !== '');
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) expect(rules.text, command).toContain(`\`${command}\``);
  });
});

describe('the README is public wording', () => {
  const IDS = [/\b(EP|OD|DM|F|B)-\d+(\.\d+)*\b/, /\b[DGQ]\d+\b/];
  const WORDS = [/\bfound[e]r\b/i, /\borchestrat[o]r\b/i];
  const ALLOWED: readonly string[] = [];

  it('holds no private ID shape and no private role word', () => {
    const offending: string[] = [];
    readme.lines.forEach((line, index) => {
      if (ALLOWED.includes(line)) return;
      if ([...IDS, ...WORDS].some((pattern) => pattern.test(line))) offending.push(`line ${index + 1}`);
    });
    expect(offending).toEqual([]);
  });
});

describe('the README makes no promise it cannot keep', () => {
  const ALLOWED_TIME_SENTENCES: readonly string[] = [];
  const ALLOWED_PLACEHOLDERS: readonly string[] = [];

  it('makes no claim about how long the path takes', () => {
    const claims = readme.lines.flatMap((line, index) => (/\b\d+(?:\.\d+)?\s*(?:-|\s)?(?:minutes?|mins?|seconds?|secs?|hours?)\b/i.test(line) && !ALLOWED_TIME_SENTENCES.includes(line) ? [`line ${index + 1}`] : []));
    expect(claims).toEqual([]);
  });

  it('holds no release placeholder that is not on the list of this test', () => {
    const tokens = [...readme.text.matchAll(/NEBURYX_RELEASE_PLACEHOLDER_[A-Z0-9_]+/g)].map((match) => match[0]);
    expect(tokens.filter((token) => !ALLOWED_PLACEHOLDERS.includes(token))).toEqual([]);
  });
});
