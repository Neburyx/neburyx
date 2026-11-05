import { describe, expect, it } from 'vitest';
import { CAPTION_WIDTH } from './caption-layout.js';
import { STYLE } from './cytoscape-renderer.js';
import { GLYPH_SIZE, NODE_DIAMETER, PIN_BADGE_SIZE } from './look.js';

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

describe('the images of an entity', () => {
  const nodeStyle = (property: string): unknown => {
    const rule = STYLE.find((candidate) => candidate.selector === 'node');
    return rule === undefined || !('style' in rule) ? undefined : Reflect.get(rule.style, property);
  };

  it('are three layers: the glyph inside the disc, the caption over it and the pin badge over it, the badge 16 px across and never clipped to the disc', () => {
    expect(nodeStyle('background-width')).toEqual([`${GLYPH_SIZE}px`, `${CAPTION_WIDTH}px`, `${PIN_BADGE_SIZE}px`]);
    expect(nodeStyle('background-height')).toHaveLength(3);
    expect(nodeStyle('background-image-containment')).toEqual(['inside', 'over', 'over']);
    expect(nodeStyle('background-clip')).toEqual(['node', 'none', 'none']);
  });

  it('put the badge on the disc\'s edge at its upper right', () => {
    const x = nodeStyle('background-position-x');
    const y = nodeStyle('background-position-y');
    expect(Array.isArray(x) && parseFloat(String(x[2])) > NODE_DIAMETER / 2).toBe(true);
    expect(Array.isArray(y) && parseFloat(String(y[2])) < NODE_DIAMETER / 2).toBe(true);
  });
});
