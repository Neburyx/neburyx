import { describe, expect, it } from 'vitest';
import { STYLE } from './cytoscape-renderer.js';

const overlayOf = (rule: (typeof STYLE)[number]): unknown => ('style' in rule ? Reflect.get(rule.style, 'overlay-opacity') : undefined);
const forSelector = (selector: string): unknown => {
  const rule = STYLE.find((candidate) => candidate.selector === selector);
  return rule === undefined ? undefined : overlayOf(rule);
};

describe('the look of a pressed entity or relationship', () => {
  it('draws no overlay behind an entity or a relationship, which the library would draw grey behind a pressed one', () => {
    expect(forSelector('node')).toBe(0);
    expect(forSelector('edge')).toBe(0);
  });

  it('has no later rule that turns the overlay back on, since the last rule that sets it is the one the library applies', () => {
    const opacities = STYLE.map(overlayOf).filter((opacity) => opacity !== undefined);
    expect(opacities.length).toBeGreaterThan(0);
    expect(opacities.every((opacity) => opacity === 0)).toBe(true);
  });
});
