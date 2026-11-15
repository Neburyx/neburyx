import { expect, test, type Page } from '@playwright/test';
import { canvasOf, openOneEntity } from './support/workspace.ts';

const SOURCE = 'banking-demo';
const TYPE = 'account';

const ref = (stableId: string) => ({ sourceId: SOURCE, entityType: TYPE, stableId });
const nodeOf = (stableId: string) => ({ ref: ref(stableId), display: { title: stableId, type: TYPE }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const edgeOf = (from: string, to: string, evidenceRefs: string[]) => ({
  ref: { sourceId: SOURCE, type: 'TRANSFERRED_TO', from: TYPE, to: TYPE, stableId: `E-${from}-${to}` },
  from: ref(from),
  to: ref(to),
  type: 'TRANSFERRED_TO',
  direction: 'from-to',
  semantics: 'stored',
  properties: [],
  evidenceRefs,
  qualityFlags: [],
});

/** The answer for chains of entity IDs, each step one relationship carrying the given evidence references. */
function pathsAnswer(chains: readonly (readonly string[])[], extra: Record<string, unknown> = {}, evidenceRefs: string[] = ['AUTH-77102']) {
  const steps = chains.map((chain) => chain.slice(1).map((id, index) => ({ from: ref(chain[index] ?? id), to: ref(id), relationshipType: 'TRANSFERRED_TO', evidenceRefs })));
  const ids = [...new Set(chains.flat())];
  const edges = new Map(steps.flat().map((step) => [`${step.from.stableId}>${step.to.stableId}`, edgeOf(step.from.stableId, step.to.stableId, evidenceRefs)]));
  return { status: 'ok', paths: steps.map((chain) => ({ hops: chain.length, steps: chain })), nodes: ids.map(nodeOf), edges: [...edges.values()], capReached: false, partial: false, elapsedMs: 420, warnings: [], ...extra };
}

const panelOf = (page: Page) => page.getByRole('complementary', { name: 'Bounded path search' });

async function openPanel(page: Page): Promise<void> {
  await openOneEntity(page, SOURCE, 'AC-1');
  await page.getByRole('button', { name: 'Paths', exact: true }).click();
  await expect(panelOf(page).getByRole('heading', { name: 'Bounded path search' })).toBeVisible();
}

/** From is the loaded entity; To is found by typing its ID, as the search of the source answers a typed ID with that entity. */
async function chooseEnds(page: Page): Promise<void> {
  const panel = panelOf(page);
  await panel.getByLabel('From', { exact: true }).selectOption({ label: 'account AC-1' });
  await panel.getByLabel('Search the source: To').fill('AC-2');
  const option = panel.getByLabel('To', { exact: true }).getByRole('option', { name: /AC-2/ });
  await expect(option).toHaveCount(1);
  await panel.getByLabel('To', { exact: true }).selectOption((await option.getAttribute('value')) ?? '');
}

async function answerWith(page: Page, answer: unknown | (() => Promise<unknown>)): Promise<void> {
  await page.route((url) => url.pathname === '/v1/graph/paths', async (route) => route.fulfill({ json: typeof answer === 'function' ? await answer() : answer }));
}

test.describe('the Paths tool', () => {
  test('opens from the tool strip, finds paths between two entities and lists them under the summary', async ({ page }) => {
    await answerWith(page, pathsAnswer([['AC-1', 'AC-2'], ['AC-1', 'AC-9', 'AC-2']]));
    await openPanel(page);
    await chooseEnds(page);
    await panelOf(page).getByRole('button', { name: 'Find paths' }).click();
    await expect(panelOf(page).getByText('2 paths · 0.42 s · cap not reached')).toBeVisible();
    await expect(panelOf(page).getByRole('heading', { name: 'Path 2 · 2 hops' })).toBeVisible();
  });

  test('adds a chosen path to the canvas and offers the evidence of its steps only then', async ({ page }) => {
    await answerWith(page, pathsAnswer([['AC-1', 'AC-9', 'AC-2']]));
    await openPanel(page);
    await chooseEnds(page);
    await panelOf(page).getByRole('button', { name: 'Find paths' }).click();
    await expect(panelOf(page).getByText('Evidence · AUTH-77102 ↗').first()).toBeVisible();
    await expect(panelOf(page).getByRole('button', { name: 'Evidence · AUTH-77102 ↗' })).toHaveCount(0);
    await panelOf(page).getByRole('button', { name: /^Path 1/ }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '3');
    await expect(panelOf(page).getByRole('button', { name: 'Evidence · AUTH-77102 ↗' }).first()).toBeVisible();
  });

  test('starts a search from the selection bar with the first two selected entities', async ({ page }) => {
    await answerWith(page, pathsAnswer([['AC-1', 'AC-9', 'AC-2']]));
    await openPanel(page);
    await chooseEnds(page);
    await panelOf(page).getByRole('button', { name: 'Find paths' }).click();
    await panelOf(page).getByRole('button', { name: /^Path 1/ }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '3');
    await page.getByRole('button', { name: 'Close Paths' }).click();
    await page.getByRole('button', { name: 'Paths between' }).click();
    await expect(panelOf(page).getByLabel('From', { exact: true })).not.toHaveValue('');
    await expect(panelOf(page).getByLabel('To', { exact: true })).not.toHaveValue('');
  });

  test('shows a slow search as Running, and Cancel ends it with the Cancelled state and no change to the graph', async ({ page }) => {
    await page.route((url) => url.pathname === '/v1/graph/paths', async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      await route.abort().catch(() => undefined);
    });
    await openPanel(page);
    await chooseEnds(page);
    await panelOf(page).getByRole('button', { name: 'Find paths' }).click();
    const banner = page.getByRole('region', { name: 'Request status' });
    await expect(banner.getByText(/^Finding shortest paths · /)).toBeVisible({ timeout: 5000 });
    await expect(banner.getByText('Maximum 3 hops; loaded graph and filters preserved.')).toBeVisible();
    await banner.getByRole('button', { name: 'Cancel' }).click();
    await expect(banner.getByText('Cancelled. No new paths added.')).toBeVisible();
    await expect(banner.getByText('0 new paths added')).toBeVisible();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  });

  test('stops a heavy search with the lower bound, and Continue with 25 sends the continued request', async ({ page }) => {
    const bodies: unknown[] = [];
    await page.route((url) => url.pathname === '/v1/graph/paths', async (route) => {
      const body = route.request().postDataJSON() as { continue?: boolean };
      bodies.push(body);
      await route.fulfill({ json: body.continue === true ? pathsAnswer([['AC-1', 'AC-2']]) : { status: 'heavy', estimate: { value: 500, quality: 'lowerBound', scope: 'paths:estimate' }, threshold: 500, continueLimit: 25, warnings: [] } });
    });
    await openPanel(page);
    await chooseEnds(page);
    await panelOf(page).getByRole('button', { name: 'Find paths' }).click();
    const banner = page.getByRole('region', { name: 'Request status' });
    await expect(banner.getByText('Estimated ≥ 500 matches · warning threshold 500')).toBeVisible();
    await banner.getByRole('button', { name: 'Continue with 25' }).click();
    await expect(panelOf(page).getByText('1 path · 0.42 s · cap not reached')).toBeVisible();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toMatchObject({ continue: true });
  });

  test('shows a partial answer as Partial, even when the limit was read, and Review moves the focus to the list', async ({ page }) => {
    await answerWith(page, pathsAnswer([['AC-1', 'AC-2']], { partial: true, retained: 5, requested: 5 }));
    await openPanel(page);
    await chooseEnds(page);
    await panelOf(page).getByRole('button', { name: 'Find paths' }).click();
    const banner = page.getByRole('region', { name: 'Request status' });
    await expect(banner.getByText(/5 of 5 requested paths retained/)).toBeVisible();
    await expect(panelOf(page).getByText('1 path · 0.42 s · partial')).toBeVisible();
    await banner.getByRole('button', { name: 'Review 5 paths' }).click();
    await expect(panelOf(page).getByRole('button', { name: /^Path 1/ })).toBeFocused();
  });
});
