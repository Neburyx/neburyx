import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AGGREGATE_WIDTH, ARROW_SHAPE, DASH_PATTERN, DERIVED_COLOR, EDGE_COLOR, EDGE_WIDTH } from '../canvas/look.js';
import { LegendSample, sampleLook, SAMPLE_HEIGHT, SAMPLE_WIDTH, type SampleKind } from './legend-samples.js';

const draw = (kind: SampleKind) => {
  const { container } = render(<LegendSample kind={kind} />);
  const svg = container.querySelector('svg');
  const line = container.querySelector('line');
  if (svg === null || line === null) throw new Error('the sample drew no line');
  return { svg, line, head: container.querySelector('polyline') };
};

describe('the legend\'s relationship samples', () => {
  it('are 32 by 12 and decorative', () => {
    const { svg } = draw('sourced');
    expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual([String(SAMPLE_WIDTH), String(SAMPLE_HEIGHT)]);
    expect([SAMPLE_WIDTH, SAMPLE_HEIGHT]).toEqual([32, 12]);
    expect(svg.getAttribute('aria-hidden')).toBe('true');
  });

  it('draw a sourced relationship as the canvas does: a solid line in the edge colour at the edge width, with no arrowhead', () => {
    const { line, head } = draw('sourced');
    expect([line.getAttribute('stroke'), line.getAttribute('stroke-width'), line.getAttribute('stroke-dasharray')]).toEqual([EDGE_COLOR, String(EDGE_WIDTH), null]);
    expect(head).toBeNull();
  });

  it('draw a rule-derived relationship dashed with the canvas\'s dash pattern in the derived colour, with no arrowhead as on the canvas', () => {
    const { line, head } = draw('derived');
    expect([line.getAttribute('stroke'), line.getAttribute('stroke-width'), line.getAttribute('stroke-dasharray')]).toEqual([DERIVED_COLOR, String(EDGE_WIDTH), DASH_PATTERN.join(' ')]);
    expect(head).toBeNull();
  });

  it('draw an aggregate solid at the aggregate width', () => {
    const { line } = draw('aggregate');
    expect([line.getAttribute('stroke'), line.getAttribute('stroke-width'), line.getAttribute('stroke-dasharray')]).toEqual([EDGE_COLOR, String(AGGREGATE_WIDTH), null]);
  });

  it('draw the direction row as a line ending in the canvas\'s arrowhead shape, at its end', () => {
    const { line, head } = draw('direction');
    expect([line.getAttribute('stroke'), line.getAttribute('stroke-width')]).toEqual([EDGE_COLOR, String(EDGE_WIDTH)]);
    expect(head?.getAttribute('data-arrow')).toBe(ARROW_SHAPE);
    expect(head?.getAttribute('points')?.split(' ')[1]).toBe(`${SAMPLE_WIDTH},${SAMPLE_HEIGHT / 2}`);
  });

  it('tell the kinds apart by shape and not by colour alone: the derived one is dashed and the aggregate thicker than the sourced one', () => {
    expect(sampleLook('derived').dash).toBeDefined();
    expect(sampleLook('sourced').dash).toBeUndefined();
    expect(sampleLook('aggregate').width).toBeGreaterThan(sampleLook('sourced').width);
  });
});
