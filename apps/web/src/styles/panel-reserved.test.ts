// @vitest-environment node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(join(import.meta.dirname, 'workspace.css'), 'utf8');
const groups = readFileSync(join(import.meta.dirname, 'groups.css'), 'utf8');
const ruleOf = (selector: string, source: string = css): string => {
  const start = source.indexOf(`${selector} {`);
  return start < 0 ? '' : source.slice(start, source.indexOf('}', start));
};

describe('what the canvas keeps clear of the right-hand panels', () => {
  it('keeps the expansion status clear of the panels at both sides and draws none when they leave no room', () => {
    expect(ruleOf('.expansion-status')).toContain('var(--panel-reserved-left, 0px) - var(--panel-reserved-right, 0px)');
    expect(ruleOf('.canvas-region[data-no-room-notice] .expansion-status')).toContain('display: none');
  });

  it.each(['.canvas-notice', '.expansion-status'])('keeps %s that far left of the right edge by the reach of the panels', (selector) => {
    expect(ruleOf(selector)).toContain('var(--panel-reserved-right, 0px)');
  });

  it('keeps the starting hint in the area the panels leave free, between the tool strip and 16 px left of the panels, wrapping when it is narrow', () => {
    const rule = ruleOf('.canvas-region[data-panels-right] .starting-hint');
    expect(rule).toContain('top: max(var(--region-top), calc(var(--scope-bottom, 0px) + var(--space-4)))');
    expect(rule).toContain('right: calc(var(--space-16) + var(--panel-reserved-right))');
    expect(rule).toContain('left: max(var(--tool-strip-clear), calc(var(--panel-reserved-left, 0px) + var(--space-16)))');
    expect(rule).toContain('overflow-wrap: anywhere');
    expect(rule).toContain('width: fit-content');
    expect(rule).toContain('margin-inline: auto');
    expect(rule).toContain('transform: none');
  });

  it('keeps the group notice in the free area between the panels at both sides', () => {
    const rule = ruleOf('.canvas-region[data-panels-left] .group-notice', groups);
    expect(rule).toContain('right: calc(var(--space-16) + var(--panel-reserved-right, 0px))');
    expect(rule).toContain('left: calc(var(--space-16) + var(--panel-reserved-left, 0px))');
    expect(rule).toContain('transform: none');
  });

  it('does not draw the hint or the notice when the panels leave no room', () => {
    expect(ruleOf('.canvas-region[data-no-room-hint] .starting-hint')).toContain('display: none');
    expect(ruleOf('.canvas-region[data-no-room-notice] .group-notice', groups)).toContain('display: none');
  });
});
