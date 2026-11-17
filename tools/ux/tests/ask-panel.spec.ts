import { expect, test, type Page } from '@playwright/test';
import { ASK_REFUSAL_SENTENCES, ERROR_TABLE, INVALID_REQUEST_ENTRIES, askAnswerSchema, type AskAnswer } from '@neburyx/contracts';
import { canvasOf } from './support/workspace.ts';

const accountOf = (sourceId: string) => ({ ref: { sourceId, entityType: 'account', stableId: 'AC-2' }, display: { title: 'Account AC-2', type: 'account' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const TOKEN = `${'1'.repeat(10)}.${'a'.repeat(64)}`;

const answeredFor = (sourceId: string): AskAnswer => askAnswerSchema.parse({ answered: { intent: 'find-account', entities: { account: 'AC-2' }, outcome: 'complete', result: { templateId: 'entity', result: accountOf(sourceId) } } });
const REFUSED: AskAnswer = askAnswerSchema.parse({ refused: { cause: 'no-intent', sentence: ASK_REFUSAL_SENTENCES['no-intent'] } });

const heavyFor = (_sourceId: string): AskAnswer =>
  askAnswerSchema.parse({ answered: { intent: 'shared-devices', entities: { account: 'AC-1' }, outcome: 'partial', continueToken: TOKEN, result: { templateId: 'shared-attribute', result: { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', presetId: 'shared-devices', estimate: { value: 500, quality: 'lowerBound', scope: 'matches' }, threshold: 500, continueLimit: 25, notices: [], warnings: [] } } } });

const summarizedFor = (sourceId: string): AskAnswer => {
  const ref = { sourceId, entityType: 'account', stableId: 'AC-1' };
  const node = { ...accountOf(sourceId), ref, display: { title: 'Account AC-1', type: 'account' } };
  return askAnswerSchema.parse({ answered: { intent: 'find-account', entities: { account: 'AC-1' }, outcome: 'complete', result: { templateId: 'entity', result: node }, summary: { sentences: [{ text: 'AC-1 is an account.', cites: ['n1'] }], citations: [{ key: 'n1', element: ref, type: 'account', title: 'Account AC-1' }] } } });
};

const header = (page: Page) => page.getByRole('banner', { name: 'Investigation' });
const panel = (page: Page) => page.locator('.ask-panel');

async function openWorkspace(page: Page): Promise<void> {
  await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: { ask: { available: true }, summary: { available: true }, assistant: { available: false } } }));
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

async function answerWith(page: Page, answer: AskAnswer | ((sourceId: string) => AskAnswer)): Promise<string[]> {
  const asked: string[] = [];
  await page.route((url) => url.pathname === '/v1/ask', async (route) => {
    const body = route.request().postDataJSON() as { question: string; sourceId: string };
    asked.push(body.question);
    await route.fulfill({ json: typeof answer === 'function' ? answer(body.sourceId) : answer });
  });
  return asked;
}

async function open(page: Page): Promise<void> {
  await header(page).getByRole('button', { name: /^Ask/ }).click();
  await expect(panel(page)).toBeVisible();
}

test.describe('the Ask panel', () => {
  test('opens and closes from the header, keeps the question while closed, and never scrolls the page sideways', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, answeredFor);
    await open(page);
    await expect(page.getByRole('heading', { name: 'Ask', level: 2 })).toBeVisible();
    await page.getByLabel('Your question').fill('who is AC-2?');
    await panel(page).getByRole('button', { name: 'Close' }).click();
    await expect(panel(page)).toHaveCount(0);
    await open(page);
    await expect(page.getByLabel('Your question')).toHaveValue('who is AC-2?');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('sends a typed question with Enter, shows the answer with its entities, and Add to graph draws the entity', async ({ page }) => {
    await openWorkspace(page);
    const asked = await answerWith(page, answeredFor);
    await open(page);
    await page.getByLabel('Your question').fill('who is AC-2?');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Answer ready' })).toBeFocused();
    await expect(panel(page).getByText('Find account')).toBeVisible();
    await expect(panel(page).getByText('AC-2', { exact: true })).toBeVisible();
    expect(asked).toEqual(['who is AC-2?']);
    await panel(page).getByRole('button', { name: /^Add / }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
  });

  test('shows a refusal with its fixed sentence, the rewording line and the manual alternatives', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, REFUSED);
    await open(page);
    await page.getByLabel('Your question').fill('hmm');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Ask did not answer' })).toBeFocused();
    await expect(panel(page).getByText(ASK_REFUSAL_SENTENCES['no-intent'])).toBeVisible();
    await expect(panel(page).getByText('1 · No question type')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Open Filters' })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Search by stable ID' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Expand' }).click();
    await expect(panel(page).getByText('To expand an entity, select it and press E, or right-click it.')).toBeVisible();
  });

  test('stops a heavy result and continues it with the kept token to a partial result', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, heavyFor);
    const continued: unknown[] = [];
    await page.route((url) => url.pathname === '/v1/ask/continue', async (route) => {
      const body = route.request().postDataJSON() as { sourceId: string };
      continued.push(route.request().postDataJSON());
      await route.fulfill({ json: { ...answeredFor(body.sourceId), answered: { ...(answeredFor(body.sourceId) as Extract<AskAnswer, { answered: unknown }>).answered, outcome: 'partial' } } });
    });
    await open(page);
    await page.getByLabel('Your question').fill('shared devices?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText('This read would be very large, so Ask stopped before reading it. At least this many match.')).toBeVisible();
    await expect(panel(page).getByText('≥ 500 matches')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Answer ready' })).toBeVisible();
    await expect(panel(page).getByText('This result is partial: the source was read only up to its limit.')).toBeVisible();
    expect(continued).toEqual([expect.objectContaining({ intent: 'shared-devices', entities: { account: 'AC-1' }, continueToken: TOKEN })]);
  });

  test('says an invalid continue is no longer valid and offers Ask again', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, heavyFor);
    const entry = INVALID_REQUEST_ENTRIES['continue-invalid'];
    await page.route((url) => url.pathname === '/v1/ask/continue', (route) => route.fulfill({ status: 400, json: { error: { code: 'INVALID_REQUEST', message: entry.message, retryable: entry.retryable, traceId: 'tr-ux', details: { reason: 'continue-invalid' } } } }));
    await open(page);
    await page.getByLabel('Your question').fill('shared devices?');
    await page.keyboard.press('Enter');
    await panel(page).getByRole('button', { name: 'Continue' }).click();
    await expect(panel(page).getByText('This stop has expired, or the graph or your access changed. Ask the question again.')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: 'Ask again' })).toBeVisible();
  });

  test('opens and closes by keyboard, and Escape gives the focus back to the control', async ({ page }) => {
    await openWorkspace(page);
    await header(page).getByRole('button', { name: /^Ask/ }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByLabel('Your question')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(header(page).getByRole('button', { name: /^Ask/ })).toBeFocused();
  });

  test('a marker of the summary selects the drawn element, and the Inspector sits beside the panel without touching it', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, summarizedFor);
    await open(page);
    await page.getByLabel('Your question').fill('who is AC-1?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText('AC-1 is an account.')).toBeVisible();
    await expect(panel(page).getByText('Sources · 1')).toBeVisible();
    await panel(page).getByRole('button', { name: /^Source 1/ }).first().click();
    const inspector = page.getByRole('complementary', { name: 'Inspector' });
    await expect(inspector).toBeVisible();
    const boxes = await Promise.all([inspector.boundingBox(), page.getByRole('complementary', { name: 'Ask' }).boundingBox()]);
    const [left, right] = boxes;
    expect(left && right && left.x + left.width <= right.x).toBe(true);
  });

  test('is dimmed when the status says Ask is not available, and opens no panel', async ({ page }) => {
    await page.goto('/dev/open-entity');
    await page.getByRole('button', { name: 'banking-demo' }).click();
    const form = page.getByRole('form', { name: 'Open an entity' });
    await form.getByLabel('Stable ID').fill('AC-1');
    await form.getByRole('button', { name: 'Open' }).click();
    await header(page).getByRole('button', { name: /^Ask/ }).click({ force: true });
    await expect(header(page).getByRole('button', { name: /^Ask/ })).toHaveAttribute('aria-disabled', 'true');
    await expect(panel(page)).toHaveCount(0);
  });

  test('shows a failure in words with Try again, which sends the same question again', async ({ page }) => {
    await openWorkspace(page);
    let calls = 0;
    await page.route((url) => url.pathname === '/v1/ask', (route) => (++calls === 1 ? route.fulfill({ status: 503, json: { error: { code: 'AUDIT_UNAVAILABLE', message: ERROR_TABLE.AUDIT_UNAVAILABLE.message, retryable: ERROR_TABLE.AUDIT_UNAVAILABLE.retryable, traceId: 'tr-ux' } } }) : route.fulfill({ json: answeredFor((route.request().postDataJSON() as { sourceId: string }).sourceId) })));
    await open(page);
    await page.getByLabel('Your question').fill('who is AC-2?');
    await page.keyboard.press('Enter');
    await panel(page).getByRole('button', { name: 'Try again' }).click();
    await expect(page.getByRole('heading', { name: 'Answer ready' })).toBeVisible();
    expect(calls).toBe(2);
  });

  test('lists the paths of a path answer, adds their entities once with Add to graph, and then shows the added note', async ({ page }) => {
    const pathAnswer = (sourceId: string): AskAnswer => {
      const ref = (stableId: string) => ({ sourceId, entityType: 'account', stableId });
      const node = (stableId: string) => ({ ...accountOf(sourceId), ref: ref(stableId), display: { title: stableId, type: 'account' } });
      const step = (from: string, to: string) => ({ from: ref(from), to: ref(to), relationshipType: 'TRANSFERRED_TO', evidenceRefs: [] });
      const cite = (key: string, id: string) => ({ key, element: ref(id), type: 'account', title: id });
      const summary = { sentences: [{ text: 'Found 1 shortest path of 2 hops between AC-1 and AC-3.', cites: ['n1', 'n2'] }, { text: 'Path 1, 2 hops.', cites: ['n1', 'n3', 'n2'] }], citations: [cite('n1', 'AC-1'), cite('n2', 'AC-3'), cite('n3', 'AC-2')] };
      return askAnswerSchema.parse({ answered: { intent: 'paths-between', entities: { first: 'AC-1', second: 'AC-3' }, outcome: 'complete', summary, result: { templateId: 'shortest-paths', result: { status: 'ok', paths: [{ hops: 2, steps: [step('AC-1', 'AC-2'), step('AC-2', 'AC-3')] }], nodes: [node('AC-1'), node('AC-2'), node('AC-3')], edges: [], capReached: false, partial: false, elapsedMs: 5, warnings: [] } } } });
    };
    await openWorkspace(page);
    await answerWith(page, pathAnswer);
    await open(page);
    await page.getByLabel('Your question').fill('how are AC-1 and AC-3 connected?');
    await page.keyboard.press('Enter');
    const paths = panel(page).getByRole('list', { name: 'Paths found' });
    await expect(paths.getByText('Path 1 · 2 hops')).toBeVisible();
    await expect(paths.getByText('AC-1 → AC-2')).toBeVisible();
    await expect(panel(page).getByRole('region', { name: 'Answer' }).getByText('Path 1, 2 hops.')).toHaveCount(0);
    await expect(paths.getByRole('button', { name: /^Source / })).toHaveCount(3);
    await panel(page).getByRole('button', { name: /^Add / }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '3');
    await expect(panel(page).getByRole('button', { name: /^Add / })).toHaveCount(0);
  });
});
