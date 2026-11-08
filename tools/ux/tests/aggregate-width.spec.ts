import { expect, test } from '@playwright/test';
import { drawing, openSample } from './support/workspace.ts';

test.describe('the width of an aggregate relationship', () => {
  test('is bold for an aggregate of 42 members and as thin as a stored relationship otherwise', async ({ page }) => {
    await openSample(page);
    const edges = (await drawing(page)).edges;
    const bold = edges.filter((edge) => edge.width === 3.5);
    expect(bold.map((edge) => edge.label)).toEqual(['USES_GADGET · 42 · exact']);
    expect(edges.filter((edge) => edge.width !== 3.5).every((edge) => edge.width === 1.4)).toBe(true);
  });
});
