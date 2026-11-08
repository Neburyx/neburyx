import { describe, expect, it } from 'vitest';
import { checkPageBounds, checkPreviewBounds, PAGE, PAGE_BYTES } from './bounds.js';

const edges = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index }));

describe('the bounds of a page', () => {
  it('accepts a full page and its nodes', () => {
    expect(() => checkPageBounds({ edges: edges(PAGE), nodes: edges(PAGE + 1) }, PAGE, 'a page')).not.toThrow();
  });

  it('fails a page with one edge over the limit, naming the count and the limit', () => {
    expect(() => checkPageBounds({ edges: edges(PAGE + 1), nodes: [] }, PAGE, 'a page')).toThrow('a page: 26 edges, over the page of 25');
  });

  it('fails a page with too many nodes', () => {
    expect(() => checkPageBounds({ edges: [], nodes: edges(PAGE + 2) }, PAGE, 'a page')).toThrow('27 nodes, over 26');
  });

  it('fails a page that serializes over the byte limit, naming the size and the limit', () => {
    const heavy = [{ text: 'x'.repeat(PAGE_BYTES) }];
    expect(() => checkPageBounds({ edges: heavy, nodes: [] }, PAGE, 'a page')).toThrow(`not under the limit of ${PAGE_BYTES}`);
  });

  it('fails a preview that serializes over its limit', () => {
    expect(() => checkPreviewBounds({ neighbors: 'x'.repeat(20_000) }, 'a preview')).toThrow('not under the limit of 16000');
    expect(() => checkPreviewBounds({ total: 1 }, 'a preview')).not.toThrow();
  });
});
