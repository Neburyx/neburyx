import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { LegendSample } from './legend-samples.js';

vi.mock('../canvas/look.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../canvas/look.js')>()),
  EDGE_COLOR: '#010203',
  EDGE_WIDTH: 2.5,
  DERIVED_COLOR: '#040506',
  DASH_PATTERN: [3, 2],
  AGGREGATE_WIDTH: 7,
  ARROW_SHAPE: 'triangle',
}));

describe('the legend\'s samples when the canvas\'s look constants change', () => {
  it.each([
    ['sourced', '#010203', '2.5', null],
    ['derived', '#040506', '2.5', '3 2'],
    ['aggregate', '#010203', '7', null],
  ] as const)('follow them for the %s sample, because they are read from the canvas\'s constants and not copied', (kind, stroke, width, dash) => {
    const { container } = render(<LegendSample kind={kind} />);
    const line = container.querySelector('line');
    expect([line?.getAttribute('stroke'), line?.getAttribute('stroke-width'), line?.getAttribute('stroke-dasharray')]).toEqual([stroke, width, dash]);
  });

  it('draw the direction sample\'s head in the canvas\'s arrowhead shape: a filled triangle when the canvas is set to one', () => {
    const { container } = render(<LegendSample kind="direction" />);
    const head = container.querySelector('[data-arrow]');
    expect([head?.tagName, head?.getAttribute('data-arrow'), head?.getAttribute('fill')]).toEqual(['polygon', 'triangle', '#010203']);
  });
});
