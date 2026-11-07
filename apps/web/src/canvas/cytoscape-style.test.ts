import { describe, expect, it } from 'vitest';
import { CAPTION_WIDTH } from './caption-layout.js';
import { STYLE } from './cytoscape-renderer.js';
import { CAPTION_FONT_SIZE, CAPTION_KNOCKOUT, CAPTION_MIN_ZOOM, FOCUS_COLOR, FOCUS_RING_GAP, FOCUS_RING_WIDTH, GLYPH_SIZE, MIN_LEGIBLE_FONT_SIZE, NODE_DIAMETER, PIN_BADGE_SIZE } from './look.js';

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

describe('the zoomed-out view', () => {
  const styleOf = (selector: string): Record<string, unknown> | undefined => {
    const rule = STYLE.find((candidate) => candidate.selector === selector);
    return rule === undefined || !('style' in rule) ? undefined : Object.fromEntries(Object.getOwnPropertyNames(rule.style).map((name) => [name, Reflect.get(rule.style, name)]));
  };

  it('hides the second image of an entity, its caption, below the limit, and shows it for a selected one only, keeping the glyph and the badge', () => {
    expect(styleOf('node.far')).toEqual({ 'background-image-opacity': [1, 0, 1] });
    expect(styleOf('node.far[?selected], node.far[?focused]')).toEqual({ 'background-image-opacity': [1, 1, 1] });
  });

  it('leaves a relationship without its label below the limit, with a class and not the library\'s own size limit (which counts a rounded texture scale including the display\'s pixel ratio), and not for a selected one', () => {
    expect(styleOf('edge.far')).toEqual({ label: '' });
    expect(styleOf('edge.far[?selected], edge.far[?focused]')).toEqual({ label: 'data(label)' });
    expect(styleOf('edge')?.['min-zoomed-font-size']).toBeUndefined();
    expect(STYLE.some((rule) => 'style' in rule && Reflect.get(rule.style, 'min-zoomed-font-size') !== undefined)).toBe(false);
  });

  it('puts the limit where 12 px caption text is drawn at the smallest legible size', () => {
    expect(CAPTION_MIN_ZOOM * CAPTION_FONT_SIZE).toBeCloseTo(MIN_LEGIBLE_FONT_SIZE, 10);
    expect(MIN_LEGIBLE_FONT_SIZE).toBe(7);
  });
});

describe('the ring of the keyboard walk', () => {
  const rule = (selector: string): Record<string, unknown> | undefined => {
    const found = STYLE.find((candidate) => candidate.selector === selector);
    return found === undefined || !('style' in found) ? undefined : Object.fromEntries(Object.getOwnPropertyNames(found.style).map((name) => [name, Reflect.get(found.style, name)]));
  };

  it('is an outline around an entity and an underlay behind a relationship, in the focus colour, after the selected rules so it shows on a selected element', () => {
    expect(rule('node[?ringed]')).toEqual({ 'outline-width': FOCUS_RING_WIDTH, 'outline-color': FOCUS_COLOR, 'outline-style': 'solid', 'outline-offset': FOCUS_RING_GAP, 'outline-opacity': 1 });
    expect(rule('edge[?ringed]')).toEqual({ 'underlay-color': FOCUS_COLOR, 'underlay-opacity': 1, 'underlay-padding': FOCUS_RING_WIDTH + FOCUS_RING_GAP, 'line-outline-width': FOCUS_RING_GAP, 'line-outline-color': CAPTION_KNOCKOUT });
    const at = (selector: string): number => STYLE.findIndex((candidate) => candidate.selector === selector);
    expect(at('node[?ringed]')).toBeGreaterThan(at('node[?selected]'));
    expect(at('edge[?ringed]')).toBeGreaterThan(at('edge[?selected]'));
  });
});
