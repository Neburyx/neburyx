import type { AssistantRead } from '@neburyx/contracts';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { ReadSteps, readLine } from './read-steps.js';

afterEach(cleanup);

const read = (over: Partial<Extract<AssistantRead, { read: true }>> = {}): AssistantRead => ({ tool: 'accounts-using-a-device', kind: 'template', subject: 'DEV-884', read: true, rows: 3, quality: 'exact', partial: false, ...over });

describe('the line of a read', () => {
  it.each([
    ['an exact count', read(), 'DEV-884 · 3 rows · complete'],
    ['one row', read({ rows: 1 }), 'DEV-884 · 1 row · complete'],
    ['an estimated count', read({ rows: 40, quality: 'estimated', kind: 'intent' }), 'DEV-884 · ~ 40 rows (estimated) · complete'],
    ['a lower bound on a pattern', read({ rows: 25, quality: 'lowerBound', kind: 'pattern' }), 'from DEV-884 · ≥ 25 rows · complete'],
    ['an unknown count on a pattern', read({ rows: undefined, quality: 'unknown', kind: 'pattern' }), 'from DEV-884 · complete · no row count'],
    ['a partial read', read({ partial: true }), 'DEV-884 · 3 rows · partial'],
    ['a read with no subject', read({ subject: undefined, kind: 'view', rows: 12 }), '12 rows · complete'],
    ['a read that did not run', { tool: 'expand', kind: 'template', read: false } as AssistantRead, 'not read'],
  ])('writes %s', (_name, entry, line) => {
    expect(readLine(entry)).toBe(line);
  });

  it('never writes a count that is not exact as a bare number', () => {
    for (const quality of ['estimated', 'lowerBound'] as const) expect(readLine(read({ quality, rows: 9 }))).not.toMatch(/· 9 rows ·/);
  });
});

describe('the steps of a turn', () => {
  const reads = [read({ tool: 'neighbours-of-an-account', subject: 'ACC-48291', rows: 12 }), read({ tool: 'fan-out', kind: 'pattern', subject: 'ACC-48291', rows: 25, quality: 'lowerBound' }), read({ tool: 'frozen', kind: 'pattern', rows: undefined, quality: 'unknown' })];

  it('is a disclosure closed by default, with the number of steps, that opens to one box per read in order with the kind tag and the quality chip', () => {
    render(<ReadSteps reads={reads} />);
    const disclosure = document.querySelector('details') as HTMLDetailsElement;
    expect(disclosure.open).toBe(false);
    expect(screen.getByText('Steps · 3')).toBeTruthy();
    const boxes = [...document.querySelectorAll('.assistant-read')].map((box) => box.textContent);
    expect(boxes).toEqual(['Ran Neighbours of an accountTemplateACC-48291 · 12 rows · completeExact', 'Ran Fan outYour patternfrom ACC-48291 · ≥ 25 rows · completeLower bound', 'Ran FrozenYour patternfrom DEV-884 · complete · no row countUnknown']);
    expect(screen.getByText(/Counts are exact/)).toBeTruthy();
  });

  it('opens and closes from the keyboard, as a native disclosure does', () => {
    render(<ReadSteps reads={reads} />);
    const summary = screen.getByText('Steps · 3');
    expect(summary.tagName).toBe('SUMMARY');
    expect((summary as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);
  });

  it('shows the boxes open with no disclosure and no footnote when asked, as a stop or a confirmation does', () => {
    render(<ReadSteps reads={reads} open />);
    expect(document.querySelector('details')).toBeNull();
    expect(document.querySelectorAll('.assistant-read')).toHaveLength(3);
    expect(screen.queryByText(/Counts are exact/)).toBeNull();
  });

  it('draws a read that did not run with no chip, and nothing at all for no reads', () => {
    const { container } = render(<ReadSteps reads={[{ tool: 'expand', kind: 'template', read: false }]} />);
    expect(container.textContent).toContain('Did not run Expand');
    expect(container.querySelector('.assistant-read-line .ask-tag')).toBeNull();
    cleanup();
    expect(render(<ReadSteps reads={[]} />).container.textContent).toBe('');
  });
});

describe('the title of a read that has a label', () => {
  it('says Ran with the label, as plain text, and falls back to the humanized id without one', () => {
    render(<ReadSteps open reads={[read({ tool: 'shared', kind: 'intent', label: 'Accounts at the same bank' }), read({ tool: 'accounts-using-a-device' }), { tool: 'byId', label: 'Account by <b>id</b>', kind: 'intent', read: false }]} />);
    expect(screen.getByText('Ran Accounts at the same bank')).toBeTruthy();
    expect(screen.getByText('Did not run Account by <b>id</b>')).toBeTruthy();
    expect(screen.getAllByText(/^Ran /).length).toBe(2);
  });
});

