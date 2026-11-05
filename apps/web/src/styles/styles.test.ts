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

  it('place the canvas regions by the frame offsets, from tokens: 16 px from the edges, 64 px from the top for the tool strip and the dock column', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--region-top:\s*64px;/);
    const workspace = readFileSync(join(DIRECTORY, 'workspace.css'), 'utf8');
    expect(workspace).toMatch(/\.region-tool-strip \{[^}]*top: var\(--region-top\);[^}]*left: var\(--space-16\);/s);
    expect(workspace).toMatch(/\.region-toggles \{[^}]*bottom: var\(--space-16\);[^}]*left: var\(--space-16\);/s);
    expect(workspace).toMatch(/\.region-zoom-controls \{[^}]*right: var\(--space-16\);[^}]*bottom: var\(--space-16\);/s);
    expect(workspace).toMatch(/\.panel-dock \{[^}]*padding: var\(--region-top\) var\(--space-16\) var\(--space-16\);/s);
  });

  it('draw the panel handle as an 8 px strip with the column-resize cursor and the collapse button 24 px, from tokens, with the handle on the other edge for a left-anchored panel', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--panel-handle-width:\s*8px;/);
    expect(tokens).toMatch(/--panel-toggle-size:\s*24px;/);
    const workspace = readFileSync(join(DIRECTORY, 'workspace.css'), 'utf8');
    expect(workspace).toMatch(/\.panel-handle \{[^}]*left: calc\(-0\.5 \* var\(--panel-handle-width\)\);[^}]*width: var\(--panel-handle-width\);[^}]*cursor: col-resize;/s);
    expect(workspace).toMatch(/\.panel-frame-left \.panel-handle \{[^}]*right: calc\(-0\.5 \* var\(--panel-handle-width\)\);/s);
    expect(workspace).toMatch(/\.panel-toggle \{[^}]*width: var\(--panel-toggle-size\);[^}]*height: var\(--panel-toggle-size\);/s);
  });

  it('draw the panel box as the frames do: a 1 px border of the workspace colour, a 10 px radius, the dock panel\'s 4 20 shadow and the floating panel\'s 4 10 shadow, on white', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--radius-host-panel:\s*10px;/);
    expect(tokens).toMatch(/--shadow-dock-panel:\s*0 4px 20px rgba\(38, 49, 73, 0\.07\);/);
    expect(tokens).toMatch(/--shadow-floating:\s*0 4px 10px rgba\(38, 49, 73, 0\.07\);/);
    const workspace = readFileSync(join(DIRECTORY, 'workspace.css'), 'utf8');
    expect(workspace).toMatch(/\.panel \{[^}]*border: var\(--border-width\) solid var\(--color-workspace-border\);[^}]*border-radius: var\(--radius-host-panel\);[^}]*background: var\(--color-surface\);[^}]*box-shadow: var\(--shadow-floating\);/s);
    expect(workspace).toMatch(/\.panel-dock \.panel \{[^}]*box-shadow: var\(--shadow-dock-panel\);/s);
  });

  it('draw the legend toggle as the frame\'s 186 by 36 strip, with the pressed look from the accent, and the legend as a grid of columns of at least 140 px with 24 px circular swatches', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--legend-toggle-width:\s*186px;/);
    expect(tokens).toMatch(/--legend-toggle-height:\s*36px;/);
    expect(tokens).toMatch(/--legend-swatch-size:\s*24px;/);
    expect(tokens).toMatch(/--legend-column-min:\s*140px;/);
    expect(tokens).toMatch(/--color-legend-swatch-border:\s*#c7cce5;/);
    const workspace = readFileSync(join(DIRECTORY, 'workspace.css'), 'utf8');
    expect(workspace).toMatch(/\.legend-toggle \{[^}]*width: var\(--legend-toggle-width\);[^}]*height: var\(--legend-toggle-height\);[^}]*padding: 0 var\(--space-12\);[^}]*border: var\(--border-width\) solid var\(--color-control-border\);[^}]*border-radius: var\(--radius\);/s);
    expect(workspace).toMatch(/\.legend-toggle\[aria-expanded='true'\] \{[^}]*border-color: var\(--color-accent\);/s);
    expect(workspace).toMatch(/\.legend-types \{[^}]*grid-template-columns: repeat\(auto-fill, minmax\(var\(--legend-column-min\), 1fr\)\);[^}]*row-gap: var\(--space-10\);/s);
    expect(workspace).toMatch(/\.legend-swatch \{[^}]*width: var\(--legend-swatch-size\);[^}]*height: var\(--legend-swatch-size\);[^}]*border-radius: 50%;/s);
  });

  it('lay out the legend\'s relationship rows as a 32 by 12 sample and a label that wraps inside the panel, 14 px apart', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--legend-sample-width:\s*32px;/);
    expect(tokens).toMatch(/--legend-sample-height:\s*12px;/);
    const workspace = readFileSync(join(DIRECTORY, 'workspace.css'), 'utf8');
    expect(workspace).toMatch(/\.legend-relationships \{[^}]*flex-direction: column;[^}]*gap: var\(--space-14\);/s);
    expect(workspace).toMatch(/\.legend-relationship \{[^}]*display: flex;[^}]*gap: var\(--space-10\);/s);
    expect(workspace).toMatch(/\.legend-sample \{[^}]*flex: none;[^}]*width: var\(--legend-sample-width\);[^}]*height: var\(--legend-sample-height\);/s);
    expect(workspace).toMatch(/\.legend-relationship-label \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/s);
    expect(workspace).toMatch(/\.legend-divider \{[^}]*height: var\(--border-width\);[^}]*background: var\(--color-control-border\);/s);
  });

  it('wrap the legend\'s labels inside their cells, top-aligned, with a long unbroken word breaking inside the cell', () => {
    const workspace = readFileSync(join(DIRECTORY, 'workspace.css'), 'utf8');
    expect(workspace).toMatch(/\.legend-type \{[^}]*min-width: 0;[^}]*align-items: flex-start;/s);
    expect(workspace).toMatch(/\.legend-type-label \{[^}]*min-width: 0;[^}]*overflow-wrap: anywhere;/s);
    expect(workspace).toMatch(/\.legend-swatch \{[^}]*flex: none;/s);
  });

  it('set the legend\'s lines to the frame\'s heights: 18 px for the heading, 13 px for the section labels, 15 px for the rows, and centre a one-line label on its swatch', () => {
    const tokens = readFileSync(join(DIRECTORY, 'tokens.css'), 'utf8');
    expect(tokens).toMatch(/--line-height-compact:\s*18px;/);
    expect(tokens).toMatch(/--line-height-caption:\s*13px;/);
    expect(tokens).toMatch(/--line-height-legend:\s*15px;/);
    const workspace = readFileSync(join(DIRECTORY, 'workspace.css'), 'utf8');
    expect(workspace).toMatch(/\.legend-panel \{[^}]*line-height: var\(--line-height-legend\);/s);
    expect(workspace).toMatch(/\.legend-heading \{[^}]*line-height: var\(--line-height-compact\);/s);
    expect(workspace).toMatch(/\.legend-label \{[^}]*line-height: var\(--line-height-caption\);/s);
    expect(workspace).toMatch(/\.legend-type-label \{[^}]*margin-top: calc\(\(var\(--legend-swatch-size\) - var\(--line-height-legend\)\) \/ 2\);/s);
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
