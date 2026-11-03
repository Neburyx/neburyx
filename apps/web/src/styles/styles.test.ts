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
    for (const name of ['--color-text', '--color-focus', '--space-4', '--space-40', '--font-size-body', '--font-size-heading-1', '--focus-outline', '--content-padding', '--section-gap']) expect(tokens).toContain(`${name}:`);
  });

  it('use no colour literal and no raw length outside the token file', () => {
    for (const sheet of stylesheets().filter((item) => item.name !== 'tokens.css')) expect(violations(sheet.css), sheet.name).toEqual([]);
  });

  it('finds a colour, a pixel size and a font size written outside the tokens', () => {
    expect(violations('a {\n  color: #fff;\n}')).toHaveLength(1);
    expect(violations('a {\n  padding: 12px;\n}')).toHaveLength(1);
    expect(violations('a {\n  font-size: 1.2rem;\n}')).toHaveLength(1);
    expect(violations('a {\n  color: rgb(1, 2, 3);\n}')).toHaveLength(1);
    expect(violations('a {\n  padding: var(--space-16);\n  margin: 0;\n}')).toEqual([]);
  });

  it('give the content area a 40 px side and top padding, a 32 px bottom padding and a 24 px gap between sections', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--content-padding:\s*40px;/);
    expect(tokens).toMatch(/--section-gap:\s*24px;/);
    expect(tokens).toMatch(/--content-padding-bottom:\s*32px;/);
    const base = readFileSync(join(DIRECTORY, 'base.css'), 'utf8');
    expect(base).toMatch(/\.page-shell main \{[^}]*gap: var\(--section-gap\);[^}]*padding: var\(--content-padding\) var\(--content-padding\) var\(--content-padding-bottom\);/s);
  });

  it('draw the keyboard focus outline from the token, and mark the current page by more than colour', () => {
    const base = readFileSync(join(DIRECTORY, 'base.css'), 'utf8');
    expect(base).toMatch(/:focus-visible \{[^}]*outline: var\(--focus-outline\);/s);
    expect(base).toMatch(/a\[aria-current='page'\] \{[^}]*(font-weight|text-decoration)/s);
  });

  it('let long unbroken values wrap in the sidebar and in the page heading, and set the Enterprise name in semibold', () => {
    const base = readFileSync(join(DIRECTORY, 'base.css'), 'utf8');
    expect(base).toMatch(/\.sidebar \{[^}]*overflow-wrap: anywhere;/s);
    expect(base).toMatch(/\.page-heading \{[^}]*overflow-wrap: anywhere;/s);
    expect(base).toMatch(/\.identity-name \{[^}]*font-weight: var\(--font-weight-semibold\);/s);
  });

  it('place the canvas regions by the frame offsets, from tokens: 16 px from the edges, 64 px from the top for the tool strip and the dock, a 320 px dock', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--region-top:\s*64px;/);
    expect(tokens).toMatch(/--dock-width:\s*320px;/);
    const workspace = readFileSync(join(DIRECTORY, 'workspace.css'), 'utf8');
    expect(workspace).toMatch(/\.region-tool-strip \{[^}]*top: var\(--region-top\);[^}]*left: var\(--space-16\);/s);
    expect(workspace).toMatch(/\.region-toggles \{[^}]*bottom: var\(--space-16\);[^}]*left: var\(--space-16\);/s);
    expect(workspace).toMatch(/\.region-zoom-controls \{[^}]*right: var\(--space-16\);[^}]*bottom: var\(--space-16\);/s);
    expect(workspace).toMatch(/\.region-dock \{[^}]*top: var\(--region-top\);[^}]*right: var\(--space-16\);[^}]*width: var\(--dock-width\);/s);
  });

  it('place the graph scope lines 24 px from the canvas left and 16 px from its top, 12 px on a 17 px line, 3 px apart', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--scope-left:\s*24px;/);
    expect(tokens).toMatch(/--scope-top:\s*16px;/);
    expect(tokens).toMatch(/--space-3:\s*3px;/);
    expect(tokens).toMatch(/--line-height-workspace:\s*17px;/);
    const workspace = readFileSync(join(DIRECTORY, 'workspace.css'), 'utf8');
    expect(workspace).toMatch(/\.graph-scope \{[^}]*top: var\(--scope-top\);[^}]*left: var\(--scope-left\);[^}]*gap: var\(--space-3\);[^}]*font-size: var\(--font-size-small\);[^}]*line-height: var\(--line-height-workspace\);/s);
  });

  it('let the occupant of the floating layer take the pointer while the empty layer lets it through, and cap the source status so a long name is cut before any control is clipped', () => {
    const workspace = readFileSync(join(DIRECTORY, 'workspace.css'), 'utf8');
    expect(workspace).toMatch(/\.region-floating \{[^}]*pointer-events: none;/s);
    expect(workspace).toMatch(/\.region-floating > \* \{[^}]*pointer-events: auto;/s);
    expect(workspace).toMatch(/\.header-actions > \* \{[^}]*flex: none;/s);
    expect(workspace).toMatch(/\.header-source \{[^}]*max-width: var\(--source-status-max-width\);[^}]*overflow: hidden;/s);
    expect(workspace).toMatch(/\.header-source p \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;/s);
  });
});
