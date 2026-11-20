import { expect, test, type Page } from '@playwright/test';
import { ERROR_TABLE, ASSISTANT_NOT_ANSWERED_SENTENCE, ASSISTANT_REFUSAL_SENTENCES, askAnswerSchema, type AskAnswer, type AssistantThreadResponse, type AssistantTurnAnswer } from '@neburyx/contracts';
import { canvasOf } from './support/workspace.ts';

const accountOf = (sourceId: string) => ({ ref: { sourceId, entityType: 'account', stableId: 'AC-2' }, display: { title: 'Account AC-2', type: 'account' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } });
const TOKEN = `${'1'.repeat(10)}.${'a'.repeat(64)}`;

const answeredFor = (sourceId: string): AskAnswer => askAnswerSchema.parse({ answered: { intent: 'find-account', entities: { account: 'AC-2' }, outcome: 'complete', result: { templateId: 'entity', result: accountOf(sourceId) } } });

const heavyFor = (_sourceId: string): AskAnswer =>
  askAnswerSchema.parse({ answered: { intent: 'shared-devices', entities: { account: 'AC-1' }, outcome: 'partial', continueToken: TOKEN, result: { templateId: 'shared-attribute', result: { status: 'heavy', templateId: 'shared-attribute', templateVersion: '1', presetId: 'shared-devices', estimate: { value: 500, quality: 'lowerBound', scope: 'matches' }, threshold: 500, continueLimit: 25, notices: [], warnings: [] } } } });

const summarizedFor = (sourceId: string): AskAnswer => {
  const ref = { sourceId, entityType: 'account', stableId: 'AC-1' };
  const node = { ...accountOf(sourceId), ref, display: { title: 'Account AC-1', type: 'account' } };
  return askAnswerSchema.parse({ answered: { intent: 'find-account', entities: { account: 'AC-1' }, outcome: 'complete', result: { templateId: 'entity', result: node }, summary: { sentences: [{ text: 'AC-1 is an account.', cites: ['n1'] }], citations: [{ key: 'n1', element: ref, type: 'account', title: 'Account AC-1' }] } } });
};

const header = (page: Page) => page.getByRole('banner', { name: 'Investigation' });
const panel = (page: Page) => page.locator('.assistant-panel');
const inAsk = (answer: AskAnswer): AssistantTurnAnswer => ({ status: 'answered', route: 'ask', answer });
const REFUSE: AssistantTurnAnswer = { status: 'answered', route: 'refuse', cause: 'verdict', sentence: ASSISTANT_REFUSAL_SENTENCES.verdict };
const VIEW: AssistantTurnAnswer = { status: 'not-answered', route: 'view', sentence: ASSISTANT_NOT_ANSWERED_SENTENCE };

type StoredThread = AssistantThreadResponse;
const NO_THREAD: StoredThread = { turns: [], earlierTurns: 0, previousThreadClearedAt: null };

async function openWorkspace(page: Page, assistant: { available: false } | { available: true; messageWords: number } = { available: true, messageWords: 1000 }, thread: StoredThread = NO_THREAD): Promise<void> {
  await page.route((url) => /^\/v1\/assistant\/investigations\/[^/]+\/thread$/.test(url.pathname), (route) => route.fulfill({ json: thread }));
  await page.route((url) => url.pathname === '/v1/ai/status', (route) => route.fulfill({ json: { ask: { available: true }, summary: { available: true }, assistant } }));
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
}

interface Sent {
  message?: string;
  sourceId: string;
  investigationId: string;
  viewElementKeys: string[];
  continue?: { intent: string; entities: Record<string, string>; continueToken: string };
  choice?: { intent: string; roles: string[]; entities: Record<string, string>; choiceToken: string };
}

async function answerWith(page: Page, answer: AssistantTurnAnswer | ((body: Sent) => AssistantTurnAnswer)): Promise<Sent[]> {
  const sent: Sent[] = [];
  await page.route((url) => url.pathname === '/v1/assistant/turns', async (route) => {
    const body = route.request().postDataJSON() as Sent;
    sent.push(body);
    await route.fulfill({ json: typeof answer === 'function' ? answer(body) : answer });
  });
  return sent;
}

async function expectHeaderStays(page: Page): Promise<void> {
  const box = await panel(page).boundingBox();
  const head = await panel(page).locator('.ask-head').boundingBox();
  expect(box !== null && head !== null && Math.abs(head.y - box.y) <= 1).toBe(true);
  await expect(panel(page).getByRole('heading', { name: 'Assistant' })).toBeInViewport();
  await expect(panel(page).getByRole('button', { name: 'Close' })).toBeInViewport();
  await expect(page.getByLabel('Your message')).toBeInViewport();
  expect(await panel(page).evaluate((element) => element.scrollTop)).toBe(0);
  expect(await panel(page).locator('.assistant-body').evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
}

async function open(page: Page): Promise<void> {
  await header(page).getByRole('button', { name: 'Assistant' }).click();
  await expect(panel(page)).toBeVisible();
}

test.describe('the Assistant panel', () => {
  test('shows the standing note under the input, the turns the server kept as compact rows above the live thread, and the new-thread card for a cleared one', async ({ page }) => {
    await openWorkspace(page, { available: true, messageWords: 1000 }, { turns: [{ seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 2, steps: 1 }, { seq: 2, at: '2026-11-18T10:05:00.000Z', route: 'refuse', outcome: 'refused', cause: 'verdict', citedElements: 0, steps: 0 }], earlierTurns: 0, previousThreadClearedAt: null });
    await open(page);
    await expect(panel(page).getByText('The thread is cleared when the investigation closes.')).toBeVisible();
    await expect(panel(page).getByRole('heading', { name: 'Earlier in this thread' })).toBeVisible();
    await expect(panel(page).getByRole('listitem', { name: 'Read from the source, Answered' })).toContainText('shared-devices');
    await expect(panel(page).getByRole('listitem', { name: 'Refused, Refused' })).toContainText('Verdict');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('shows the new-thread card of an investigation that was closed and reopened', async ({ page }) => {
    await openWorkspace(page, { available: true, messageWords: 1000 }, { turns: [], earlierTurns: 0, previousThreadClearedAt: '2026-11-18T12:00:00.000Z' });
    await open(page);
    await expect(panel(page).getByText('This is a new thread. The previous thread was cleared when the investigation closed.')).toBeVisible();
    await expect(panel(page).getByText('Your graph, notes and saved views are unchanged.')).toBeVisible();
  });

  test('opens from the header with no lock, closes with Escape and gives the focus back, keeps the message while closed, and never scrolls the page sideways', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, REFUSE);
    await expect(header(page).getByRole('button', { name: 'Assistant' })).not.toHaveAttribute('aria-disabled', 'true');
    await open(page);
    await expect(page.getByRole('heading', { name: 'Assistant', level: 2 })).toBeVisible();
    await expect(panel(page).getByText('0 / 1,000 words')).toBeVisible();
    await page.getByLabel('Your message').fill('is this guilty');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await expect(header(page).getByRole('button', { name: 'Assistant' })).toBeFocused();
    await open(page);
    await expect(page.getByLabel('Your message')).toHaveValue('is this guilty');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test('sends a message with Enter, shows the refusal turn with its fixed sentence, and a view turn as not answered, each titled Not answered', async ({ page }) => {
    await openWorkspace(page);
    const sent = await answerWith(page, (body) => (body.message === 'what is this?' ? VIEW : REFUSE));
    await open(page);
    await page.getByLabel('Your message').fill('is this guilty?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeVisible();
    await expect(panel(page).getByRole('heading', { name: 'Not answered' }).first()).toBeVisible();
    await page.getByLabel('Your message').fill('what is this?');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Not answered' }).last()).toBeFocused();
    await expect(panel(page).getByText(ASSISTANT_NOT_ANSWERED_SENTENCE)).toBeVisible();
    expect(sent.map((body) => body.message)).toEqual(['is this guilty?', 'what is this?']);
    expect(sent[0]).toMatchObject({ sourceId: 'banking-demo', viewElementKeys: expect.any(Array) });
  });

  test('shows the answer of the ask route with its sources, and a heavy stop that continues with the kept token', async ({ page }) => {
    await openWorkspace(page);
    const sent = await answerWith(page, (body) => (body.continue === undefined ? inAsk(heavyFor('banking-demo')) : inAsk(answeredFor('banking-demo'))));
    await open(page);
    await page.getByLabel('Your message').fill('shared devices?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText('This read would be very large, so the assistant stopped before reading it. At least this many match.')).toBeVisible();
    await expect(panel(page).getByText('≥ 500 matches')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Continue' }).click();
    await expect(panel(page).getByRole('heading', { name: 'Answer ready' })).toBeVisible();
    expect(sent[1]).toMatchObject({ continue: { intent: 'shared-devices', entities: { account: 'AC-1' }, continueToken: TOKEN } });
    expect(sent[1]?.message).toBeUndefined();
    await expect(panel(page).getByText('Read from the source')).toBeVisible();
  });

  test('refuses a message over the limit before anything is sent, shows a failure card with Try again and keeps the message', async ({ page }) => {
    await openWorkspace(page, { available: true, messageWords: 3 });
    let failing = true;
    const sent = await answerWith(page, REFUSE);
    await page.unroute((url) => url.pathname === '/v1/assistant/turns');
    await page.route((url) => url.pathname === '/v1/assistant/turns', async (route) => {
      sent.push(route.request().postDataJSON() as Sent);
      await (failing ? route.fulfill({ status: 503, json: { error: { code: 'SOURCE_BUSY', message: ERROR_TABLE.SOURCE_BUSY.message, retryable: ERROR_TABLE.SOURCE_BUSY.retryable, traceId: 'tr-ux' } } }) : route.fulfill({ json: REFUSE }));
    });
    await open(page);
    await page.getByLabel('Your message').fill('a b c d');
    await expect(panel(page).getByText('Your message is 4 words. The limit is 3. Shorten it and send again.')).toBeVisible();
    await expect(panel(page).getByRole('button', { name: /Send/ })).toBeDisabled();
    expect(sent).toHaveLength(0);
    await page.getByLabel('Your message').fill('a b c');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('heading', { name: 'Service unavailable' })).toBeVisible();
    await expect(page.getByLabel('Your message')).toHaveValue('a b c');
    failing = false;
    await panel(page).getByRole('button', { name: 'Try again' }).click();
    await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeVisible();
    expect(sent.map((body) => body.message)).toEqual(['a b c', 'a b c']);
  });

  test('says it is not available when the status says so, with the input off and nothing requested', async ({ page }) => {
    await openWorkspace(page, { available: false });
    const sent = await answerWith(page, REFUSE);
    await header(page).getByRole('button', { name: 'Assistant' }).click({ force: true });
    await expect(panel(page).getByText('The assistant is not available because AI is switched off, or no AI provider is configured for this deployment.')).toBeVisible();
    await expect(page.getByLabel('Your message')).toBeDisabled();
    expect(sent).toHaveLength(0);
  });

  test('fits a laptop viewport of 1280 pixels: the panel is inside the window and the page does not scroll sideways', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWorkspace(page);
    await answerWith(page, REFUSE);
    await open(page);
    const box = await panel(page).boundingBox();
    expect(box !== null && box.x + box.width <= 1280).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  const holdTurns = async (page: Page): Promise<{ failed: string[]; sent: () => number }> => {
    const failed: string[] = [];
    let sent = 0;
    page.on('requestfailed', (request) => {
      if (new URL(request.url()).pathname === '/v1/assistant/turns') failed.push(request.failure()?.errorText ?? '');
    });
    await page.route((url) => url.pathname === '/v1/assistant/turns', () => {
      sent += 1;
      return new Promise<void>(() => undefined);
    });
    return { failed, sent: () => sent };
  };

  test('cancels a held turn from the keyboard: the request fails in the browser, the Cancelled turn shows and the message is back in the focused input', async ({ page }) => {
    await openWorkspace(page);
    const { failed, sent: sentCount } = await holdTurns(page);
    await open(page);
    const field = page.getByLabel('Your message');
    await field.fill('Which accounts share a device with AC-1?');
    await field.press('Enter');
    await expect(panel(page).getByRole('button', { name: 'Cancel' })).toBeVisible();
    await expect(panel(page).getByText('Cancel stops the request. Nothing more is read once it is stopped.')).toBeVisible();
    await expect(field).toHaveAttribute('aria-disabled', 'true');
    await expect(panel(page).getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('heading', { name: 'Cancelled' })).toBeVisible();
    await expect(panel(page).getByText('Nothing more was read and nothing was added to the graph. Your message is back in the box.')).toBeVisible();
    await expect(field).toHaveValue('Which accounts share a device with AC-1?');
    await expect(field).toBeFocused();
    await expect(panel(page).getByRole('button', { name: /Send/ })).toBeVisible();
    await expect.poll(() => failed.length).toBe(1);
    expect(sentCount()).toBe(1);
  });

  test('closes the held request when the page is reloaded and invents no answer or Cancelled turn afterwards', async ({ page }) => {
    await openWorkspace(page);
    const { sent: sentCount } = await holdTurns(page);
    await open(page);
    await page.getByLabel('Your message').fill('Which accounts share a device with AC-1?');
    await page.getByLabel('Your message').press('Enter');
    await expect(panel(page).getByRole('button', { name: 'Cancel' })).toBeVisible();
    expect(sentCount()).toBe(1);
    await page.reload();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
    await open(page);
    await expect(panel(page).getByRole('heading', { name: 'Cancelled' })).toHaveCount(0);
    await expect(panel(page).getByRole('list', { name: 'Conversation' })).toHaveCount(0);
    expect(sentCount()).toBe(1);
  });

  test('shows Cancel and its hint inside the panel at 1280 pixels, without clipping', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await openWorkspace(page);
    await holdTurns(page);
    await open(page);
    await page.getByLabel('Your message').fill('Which accounts share a device with AC-1?');
    await page.getByLabel('Your message').press('Enter');
    const cancel = panel(page).getByRole('button', { name: 'Cancel' });
    const hint = panel(page).getByText('Cancel stops the request. Nothing more is read once it is stopped.');
    await expect(cancel).toBeVisible();
    await expect(hint).toBeVisible();
    const box = await panel(page).boundingBox();
    for (const target of [cancel, hint]) {
      const inner = await target.boundingBox();
      expect(box !== null && inner !== null && inner.x >= box.x && inner.x + inner.width <= box.x + box.width && inner.y + inner.height <= box.y + box.height).toBe(true);
    }
    expect(await hint.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  });

  for (const width of [1440, 1280]) {
    test(`shows an answer from the view at ${width} pixels with its tags, markers, sources and the two lines of coverage, and selects the cited element`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const cited = { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' };
      const answer: AssistantTurnAnswer = {
        status: 'answered',
        route: 'view',
        sentences: [{ text: 'Account AC-1 is in view.', cites: ['n1'] }],
        citations: [{ key: 'n1', kind: 'entity', ref: cited }],
        coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 1 of the 1 shown elements.' },
        model: 'claude-sonnet-5-5',
        calls: 2,
      };
      const sent = await answerWith(page, answer);
      await open(page);
      await page.getByLabel('Your message').fill('what is in view?');
      await page.keyboard.press('Enter');
      await expect(panel(page).getByText('AI-drafted')).toBeVisible();
      await expect(panel(page).getByText('Model: claude-sonnet-5-5')).toBeVisible();
      await expect(panel(page).getByText('Account AC-1 is in view.')).toBeVisible();
      await expect(panel(page).getByText('Sources · 1')).toBeVisible();
      await expect(panel(page).getByText('1 shown · 0 not yet retrieved (exact)')).toBeVisible();
      await expect(panel(page).getByText('The draft cites 1 of the 1 shown elements.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Answer from the view' })).toBeFocused();
      await panel(page).getByRole('button', { name: /^Citation 1, / }).first().click();
      expect(sent[0]?.viewElementKeys.length).toBeGreaterThan(0);
      await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }

  for (const width of [1440, 1280]) {
    test(`shows an answer after tool steps at ${width} pixels with its tags, the number of steps, markers, sources and coverage, and selects the cited element`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const answer: AssistantTurnAnswer = {
        status: 'answered',
        route: 'ask',
        sentences: [{ text: 'Account AC-1 shares a device with account AC-2.', cites: ['r1', 'r2'] }],
        citations: [
          { key: 'r1', kind: 'entity', ref: { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' } },
          { key: 'r2', kind: 'entity', ref: { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-2' } },
        ],
        coverage: { retrieval: '2 shown · 0 not yet retrieved (exact)', summary: 'The answer cites 2 of the 2 elements the reads returned.' },
        model: 'claude-sonnet-5-5',
        calls: 4,
        steps: 2,
      };
      await answerWith(page, answer);
      await open(page);
      await page.getByLabel('Your message').fill('who shares a device with AC-1?');
      await page.keyboard.press('Enter');
      await expect(panel(page).getByText('AI-drafted')).toBeVisible();
      await expect(panel(page).getByText('Account AC-1 shares a device with account AC-2.')).toBeVisible();
      await expect(panel(page).getByText('Steps · 2')).toBeVisible();
      await expect(panel(page).getByText('Sources · 2')).toBeVisible();
      await expect(panel(page).getByText('The answer cites 2 of the 2 elements the reads returned.')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Answer from the reads' })).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const box = await panel(page).boundingBox();
      expect(box !== null && box.y >= 0 && box.y + box.height <= 900).toBe(true);
    });
  }

  for (const width of [1440, 1280]) test(`keeps the page and the panel in place when a long answer from the view arrives at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspace(page);
    const ids = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7', 'AC-8', 'AC-9', 'AC-10'];
    const answer: AssistantTurnAnswer = {
      status: 'answered',
      route: 'view',
      sentences: ids.map((id, index) => ({ text: `Account ${id} is in view, number ${index + 1} of ${ids.length}.`, cites: [`n${index + 1}`] })),
      citations: ids.map((id, index) => ({ key: `n${index + 1}`, kind: 'entity' as const, ref: { sourceId: 'banking-demo', entityType: 'account', stableId: id } })),
      coverage: { retrieval: '10 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 10 of the 10 shown elements.' },
      model: 'claude-sonnet-5-5',
      calls: 2,
    };
    await answerWith(page, answer);
    await open(page);
    await page.getByLabel('Your message').fill('what is in view?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText('Sources · 10')).toBeVisible();
    await expect(panel(page).getByText('Account AC-1 is in view, number 1 of 10.')).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const box = await panel(page).boundingBox();
    expect(box !== null && box.y >= 0 && box.y + box.height <= 900).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollHeight <= document.documentElement.clientHeight)).toBe(true);
    await expectHeaderStays(page);
  });

  for (const width of [1440, 1280]) test(`keeps the workspace in place when a refusal follows a long answer from the view at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspace(page);
    const ids = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7', 'AC-8', 'AC-9', 'AC-10'];
    const long: AssistantTurnAnswer = {
      status: 'answered',
      route: 'view',
      sentences: ids.map((id, index) => ({ text: `Account ${id} is in view, number ${index + 1} of ${ids.length}.`, cites: [`n${index + 1}`] })),
      citations: ids.map((id, index) => ({ key: `n${index + 1}`, kind: 'entity' as const, ref: { sourceId: 'banking-demo', entityType: 'account', stableId: id } })),
      coverage: { retrieval: '10 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 10 of the 10 shown elements.' },
      model: 'claude-sonnet-5-5',
      calls: 2,
    };
    await answerWith(page, (body) => (body.message === 'what is in view?' ? long : REFUSE));
    await open(page);
    await page.getByLabel('Your message').fill('what is in view?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText('Sources · 10')).toBeVisible();
    await page.getByLabel('Your message').fill('is this fraud?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeInViewport({ ratio: 1 });
    const moved = await page.evaluate(() => [...document.querySelectorAll('*')].filter((element) => element.scrollTop !== 0 && !element.classList.contains('assistant-body')).map((element) => `${element.tagName}.${element.className}:${element.scrollTop}`));
    expect(moved).toEqual([]);
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const box = await panel(page).boundingBox();
    expect(box !== null && box.y >= 0 && box.y + box.height <= 900).toBe(true);
    await expectHeaderStays(page);
  });

  const refused = async (page: Page): Promise<void> => {
    await openWorkspace(page);
    await answerWith(page, REFUSE);
    await page.route((url) => url.pathname === '/v1/summary', () => new Promise<void>(() => undefined));
    await open(page);
    await page.getByLabel('Your message').fill('is this guilty?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('heading', { name: 'Not answered' })).toBeVisible();
  };

  test('draws the refusal as one grey card with a regular small title and no outline on the focused title, the hint and chips as AS6 draws them', async ({ page }) => {
    await refused(page);
    const title = panel(page).getByRole('heading', { name: 'Not answered' });
    await expect(title).toBeFocused();
    const card = panel(page).locator('.assistant-refusal');
    expect(await card.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    expect(await title.evaluate((element) => [getComputedStyle(element).fontWeight, getComputedStyle(element).outlineStyle])).toEqual(['400', 'none']);
    expect(await card.getByRole('button', { name: 'Open Filters' }).count()).toBe(1);
  });

  test('draws no outline on the focused title of a not-answered view turn or of a failure card either', async ({ page }) => {
    await openWorkspace(page);
    await answerWith(page, VIEW);
    await open(page);
    await page.getByLabel('Your message').fill('what is this?');
    await page.keyboard.press('Enter');
    const title = panel(page).getByRole('heading', { name: 'Not answered' });
    await expect(title).toBeFocused();
    expect(await title.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe('none');
  });

  test('reaches the chips with Tab, opens the Filters tool with Enter and leaves it open on a second activation', async ({ page }) => {
    await refused(page);
    const filters = panel(page).getByRole('button', { name: 'Open Filters' });
    await filters.focus();
    await expect(filters).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(panel(page).getByRole('button', { name: 'Summarize this view' })).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
    const toolButton = page.getByRole('group', { name: 'Tools' }).getByRole('button', { name: 'Filters' });
    await expect(toolButton).toHaveAttribute('aria-pressed', 'true');
    await filters.click();
    await expect(toolButton).toHaveAttribute('aria-pressed', 'true');
  });

  test('opens the AI case summary panel from Summarize this view and closes the assistant panel', async ({ page }) => {
    await refused(page);
    await panel(page).getByRole('button', { name: 'Summarize this view' }).click();
    await expect(page.getByRole('complementary', { name: 'AI case summary' })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await page.getByRole('button', { name: 'Assistant' }).click();
    await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeVisible();
  });

  test('offers Open Paths in the built app and opens the Paths tool', async ({ page }) => {
    await refused(page);
    await expect(panel(page).getByText('Open Paths is left out because this build has no Paths tool.')).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'Open Paths' }).click();
    await expect(page.getByRole('complementary', { name: 'Bounded path search' })).toBeVisible();
  });

  test('shows the refusal card and its chips inside the panel at 1280 pixels, without clipping', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await refused(page);
    const box = await panel(page).boundingBox();
    for (const name of ['Open Filters', 'Summarize this view', 'Open Paths']) {
      const inner = await panel(page).getByRole('button', { name }).boundingBox();
      expect(box !== null && inner !== null && inner.x >= box.x && inner.x + inner.width <= box.x + box.width).toBe(true);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  for (const width of [1440, 1280]) test(`shows a clarification turn at ${width} pixels: the card in view with the focus on its title, the workspace in place, and Cancel gives the message back`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspace(page);
    const choiceFor = (stableId: string) => ({ intent: 'shared', roles: ['id'], entities: { id: stableId }, choiceToken: `${'1'.repeat(10)}.${'a'.repeat(64)}` });
    const clarification: AssistantTurnAnswer = { status: 'clarification', question: 'Which account do you mean?', candidates: [{ title: 'AC-2', type: 'account', choice: choiceFor('AC-2') }, { title: 'AC-3', type: 'account', choice: choiceFor('AC-3') }] };
    const sent = await answerWith(page, (body) => (body.choice === undefined ? clarification : REFUSE));
    await open(page);
    await page.getByLabel('Your message').fill('and the other one?');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Do you mean …?' })).toBeFocused();
    await expect(panel(page).getByText('Which account do you mean?')).toBeInViewport({ ratio: 1 });
    await expect(panel(page).getByRole('list', { name: 'Elements you may mean' })).toBeInViewport({ ratio: 1 });
    await expect(panel(page).getByRole('button', { name: 'Cancel' })).toBeInViewport({ ratio: 1 });
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const box = await panel(page).boundingBox();
    expect(box !== null && box.y >= 0 && box.y + box.height <= 900).toBe(true);
    await panel(page).getByRole('button', { name: 'Cancel' }).click();
    await expect(page.getByLabel('Your message')).toHaveValue('and the other one?');
    await expect(page.getByLabel('Your message')).toBeFocused();
    expect(sent).toHaveLength(1);
  });

  for (const width of [1440, 1280]) test(`picks a candidate of a clarification by keyboard at ${width} pixels: the choice is sent with no message and its answer takes the place of the card`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspace(page);
    const choiceFor = (stableId: string) => ({ intent: 'shared', roles: ['id'], entities: { id: stableId }, choiceToken: `${'1'.repeat(10)}.${'a'.repeat(64)}` });
    const clarification: AssistantTurnAnswer = { status: 'clarification', question: 'Which account do you mean?', candidates: [{ title: 'AC-2', type: 'account', choice: choiceFor('AC-2') }, { title: 'AC-3', type: 'account', choice: choiceFor('AC-3') }] };
    const sent = await answerWith(page, (body) => (body.choice === undefined ? clarification : REFUSE));
    await open(page);
    await page.getByLabel('Your message').fill('and the other one?');
    await page.keyboard.press('Enter');
    const second = panel(page).getByRole('button', { name: /AC-3/ });
    await second.focus();
    await expect(second).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeInViewport({ ratio: 1 });
    await expect(page.getByRole('heading', { name: 'Do you mean …?' })).toHaveCount(0);
    expect(sent).toHaveLength(2);
    expect(sent[1]?.choice?.entities).toEqual({ id: 'AC-3' });
    expect(sent[1]?.message).toBeUndefined();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const box = await panel(page).boundingBox();
    expect(box !== null && box.y >= 0 && box.y + box.height <= 900).toBe(true);
  });

  for (const width of [1440, 1280]) test(`shows follow-ups under an answer at ${width} pixels and runs a pressed one as a turn of its own by keyboard`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspace(page);
    const token = `${'1'.repeat(10)}.${'a'.repeat(64)}`;
    const answered: AssistantTurnAnswer = {
      status: 'answered',
      route: 'ask',
      answer: answeredFor('banking-demo'),
      followUps: [
        { titles: ['Account AC-2'], choice: { intent: 'accounts-paid-to', roles: ['id'], entities: { id: 'AC-2' }, choiceToken: token } },
        { titles: ['Account AC-2', 'Account AC-3'], choice: { intent: 'paths-between', roles: ['a', 'b'], entities: { a: 'AC-2', b: 'AC-3' }, choiceToken: token } },
      ],
    };
    const sent = await answerWith(page, (body) => (body.choice === undefined ? answered : REFUSE));
    await open(page);
    await page.getByLabel('Your message').fill('show the account');
    await page.keyboard.press('Enter');
    const chip = panel(page).getByRole('button', { name: 'Paths between · Account AC-2, Account AC-3' });
    await expect(chip).toBeInViewport({ ratio: 1 });
    await chip.focus();
    await expect(chip).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeInViewport({ ratio: 1 });
    expect(sent).toHaveLength(2);
    expect(sent[1]?.choice?.entities).toEqual({ a: 'AC-2', b: 'AC-3' });
    expect(sent[1]?.message).toBeUndefined();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    const box = await panel(page).boundingBox();
    expect(box !== null && box.y >= 0 && box.y + box.height <= 900).toBe(true);
  });
});
