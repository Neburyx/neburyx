// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const DIRECTORY = join(import.meta.dirname);
const sheet = (name: string): string => readFileSync(join(DIRECTORY, name), 'utf8');
const CONTROLS = sheet('controls.css');
const MIN_TEXT_CONTRAST = 4.5;
const VARIANT = /^button\.(primary|secondary|link)\b/;

function rulesOf(css: string): Array<{ readonly selectors: readonly string[]; readonly body: string }> {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selectors: topLevelSplit(match[1] ?? ''), body: match[2] ?? '' }));
}

function topLevelSplit(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of list) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else current += character;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

function withoutZeroSpecificity(selector: string): string {
  let result = selector;
  for (;;) {
    const start = result.indexOf(':where(');
    if (start === -1) return result.trim();
    let depth = 0;
    let end = start;
    for (; end < result.length; end += 1) {
      if (result[end] === '(') depth += 1;
      if (result[end] === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    result = result.slice(0, start) + result.slice(end + 1);
  }
}

function tokenColours(): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of sheet('tokens.css').matchAll(/--([\w-]+):\s*(#[0-9a-fA-F]{6});/g)) found.set(match[1] ?? '', match[2] ?? '');
  return found;
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrast(foreground: string, background: string): number {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((left, right) => right - left);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

describe('the shared control styles', () => {
  it('draw every plain control from a rule whose selector has zero specificity, and every other rule only for the three variant classes', () => {
    const selectors = rulesOf(CONTROLS).flatMap((rule) => rule.selectors);
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      if (VARIANT.test(selector)) continue;
      expect(selector.startsWith(':where('), selector).toBe(true);
      expect(withoutZeroSpecificity(selector), selector).toMatch(/^(::placeholder)?$/);
    }
  });

  it('match a control with no class and a control with an empty class, for each of the three kinds', () => {
    const defaults = rulesOf(CONTROLS)[0]?.selectors.join(' ') ?? '';
    for (const element of ['button', 'select', 'input']) {
      expect(defaults).toContain(`${element}:not([class])`);
      expect(defaults).toContain(`${element}[class='']`);
    }
    expect(defaults).toContain("input:not([class]):is(:not([type]), [type='text'], [type='search'])");
  });

  it('scope every state rule to the plain controls or one of the variant classes, so none reaches a canvas control', () => {
    const states = rulesOf(CONTROLS).flatMap((rule) => rule.selectors).filter((selector) => /:hover|:disabled|aria-disabled|aria-busy/.test(selector));
    expect(states.length).toBeGreaterThan(0);
    for (const selector of states) expect(selector.startsWith(':where(') || VARIANT.test(selector), selector).toBe(true);
  });

  it('give the padding, the placeholder and the disabled look to text-like fields only, and leave a checkbox or a date field alone', () => {
    const fieldRules = rulesOf(CONTROLS).flatMap((rule) => rule.selectors).filter((selector) => selector.includes('input') && !selector.startsWith(':where(\n') );
    expect(fieldRules.length).toBeGreaterThan(0);
    for (const selector of fieldRules) expect(selector, selector).toContain(":is(:not([type]), [type='text'], [type='search'])");
  });

  it('keep a disabled or busy control from reacting to the pointer', () => {
    const hovers = rulesOf(CONTROLS).flatMap((rule) => rule.selectors).filter((selector) => selector.includes(':hover'));
    expect(hovers.length).toBeGreaterThan(0);
    for (const selector of hovers) expect(selector, selector).toContain(":not(:disabled, [aria-disabled='true'], [aria-busy='true'])");
  });

  it('hold the primary and secondary button styles, and not the Sources styles', () => {
    expect(CONTROLS).toMatch(/button\.primary \{[^}]*background: var\(--color-accent\);/s);
    expect(CONTROLS).toMatch(/button\.link \{[^}]*border: 0;/s);
    expect(sheet('sources.css')).not.toMatch(/button\.(primary|secondary)/);
  });

  it('use no colour literal and no raw length, and no rule removes a control outline', () => {
    expect(CONTROLS).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/);
    expect(CONTROLS).not.toMatch(/outline:\s*(none|0)/);
    const removals = readdirSync(DIRECTORY).filter((name) => name.endsWith('.css')).filter((name) => /outline:\s*(none|0)\s*;/.test(sheet(name)) && name !== 'base.css');
    expect(removals).toEqual([]);
  });

  it('keep the text of each control state at 4.5 to 1 or more against its own fill, the opacity of a busy control included', () => {
    const colours = tokenColours();
    const at = (name: string): string => {
      const value = colours.get(name);
      if (value === undefined) throw new Error(`token ${name} is not a six-digit colour`);
      return value;
    };
    const pairs: ReadonlyArray<readonly [string, string, string]> = [
      ['a plain control', 'color-text', 'color-surface'],
      ['a plain control, hovered', 'color-text', 'color-surface-muted'],
      ['a plain control, placeholder', 'color-text-muted', 'color-surface'],
      ['a disabled control', 'color-text-muted', 'color-surface-muted'],
      ['primary', 'color-surface', 'color-accent'],
      ['primary, hovered', 'color-surface', 'color-accent-hover'],
      ['primary, busy (full strength)', 'color-surface', 'color-accent'],
      ['link-style on the page', 'color-accent', 'color-surface'],
      ['link-style on a muted fill', 'color-accent', 'color-surface-muted'],
      ['link-style, disabled', 'color-text-muted', 'color-surface'],
      ['a flyout hint, on the page', 'color-flyout-hint', 'color-surface'],
      ['a flyout hint, on a muted fill', 'color-flyout-hint', 'color-surface-muted'],
      ['a flyout hint, on a chosen or hovered menu row', 'color-flyout-hint', 'color-row-chosen'],
    ];
    for (const [label, foreground, background] of pairs) expect(contrast(at(foreground), at(background)), label).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it('keep the hint that tells why a layout row is unavailable at full strength, and dim only the label of that row', () => {
    const workspace = sheet('workspace.css');
    expect(workspace).toMatch(/\.layout-list \.menu-row-disabled \{[^}]*opacity: 1;/s);
    expect(workspace).toMatch(/\.layout-list \.menu-row-disabled \.menu-label \{[^}]*opacity: var\(--opacity-disabled\);/s);
  });

  it('keep the muted text of the graph scope lines at 4.5 to 1 on their backdrop, the surface at 85 % over black, the darkest thing that can lie behind it', () => {
    const colours = tokenColours();
    const surface = colours.get('color-surface');
    const muted = colours.get('color-workspace-muted');
    if (surface === undefined || muted === undefined) throw new Error('the tokens are not six-digit colours');
    const over = [1, 3, 5].map((index) => Math.round(0.85 * parseInt(surface.slice(index, index + 2), 16)).toString(16).padStart(2, '0')).join('');
    expect(sheet('workspace.css')).toMatch(/\.graph-scope \{[^}]*background: color-mix\(in srgb, var\(--color-surface\) 85%, transparent\);/s);
    expect(contrast(muted, `#${over}`)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
  });

  it('leave the check of the browser\'s default look as the only pass: no stylesheet has a colour-scheme rule, and one that adds it must extend that check for a dark pass first', () => {
    const found = readdirSync(DIRECTORY).filter((name) => name.endsWith('.css')).filter((name) => /prefers-color-scheme|data-theme/.test(sheet(name)));
    expect(found, 'a dark scheme needs a dark pass of tools/ux/tests/default-look.spec.ts and a contrast test of its pairs').toEqual([]);
  });

  it('measure the contrast it asserts', () => {
    expect(contrast('#ffffff', '#000000')).toBeCloseTo(21, 0);
    expect(contrast('#777777', '#ffffff')).toBeLessThan(MIN_TEXT_CONTRAST);
  });
});
