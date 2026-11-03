// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIRECTORY = join(import.meta.dirname);
const COLOUR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;
const LENGTH = /(?<![\w-])(?:\d*\.)?\d+(?:px|rem|em|pt|vw|vh)\b/;

function violations(css: string): string[] {
  return css
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.includes(':') && line.endsWith(';'))
    .filter((line) => COLOUR.test(line) || LENGTH.test(line.replaceAll(/var\([^)]*\)/g, '')))
    .filter((line) => !/^0(px)?$/.test(line));
}

function stylesheets(): Array<{ readonly name: string; readonly css: string }> {
  return readdirSync(DIRECTORY)
    .filter((name) => name.endsWith('.css'))
    .map((name) => ({ name, css: readFileSync(join(DIRECTORY, name), 'utf8') }));
}

describe('the stylesheets', () => {
  it('define colours, spacing steps, type sizes and the focus outline once, as tokens', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    for (const name of ['--color-text', '--color-focus', '--space-1', '--space-5', '--font-size-body', '--font-size-heading-1', '--focus-outline', '--content-padding', '--section-gap']) expect(tokens).toContain(`${name}:`);
  });

  it('use no colour literal and no raw length outside the token file', () => {
    for (const sheet of stylesheets().filter((item) => item.name !== 'tokens.css')) expect(violations(sheet.css), sheet.name).toEqual([]);
  });

  it('finds a colour, a pixel size and a font size written outside the tokens', () => {
    expect(violations('a {\n  color: #fff;\n}')).toHaveLength(1);
    expect(violations('a {\n  padding: 12px;\n}')).toHaveLength(1);
    expect(violations('a {\n  font-size: 1.2rem;\n}')).toHaveLength(1);
    expect(violations('a {\n  color: rgb(1, 2, 3);\n}')).toHaveLength(1);
    expect(violations('a {\n  padding: var(--space-3);\n  margin: 0;\n}')).toEqual([]);
  });

  it('give the content area a 40 px side and top padding and a 24 px gap between sections', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--content-padding:\s*40px;/);
    expect(tokens).toMatch(/--section-gap:\s*24px;/);
    const base = readFileSync(join(DIRECTORY, 'base.css'), 'utf8');
    expect(base).toMatch(/main \{[^}]*gap: var\(--section-gap\);[^}]*padding: var\(--content-padding\) var\(--content-padding\) 0;/s);
  });

  it('draw the keyboard focus outline from the token, and mark the current page by more than colour', () => {
    const base = readFileSync(join(DIRECTORY, 'base.css'), 'utf8');
    expect(base).toMatch(/:focus-visible \{[^}]*outline: var\(--focus-outline\);/s);
    expect(base).toMatch(/a\[aria-current='page'\] \{[^}]*(font-weight|text-decoration)/s);
  });
});
