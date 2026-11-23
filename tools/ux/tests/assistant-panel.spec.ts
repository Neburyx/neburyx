import { expect, test, type Page } from '@playwright/test';
import { ERROR_TABLE, ASSISTANT_NOT_ANSWERED_SENTENCE, ASSISTANT_REFUSAL_SENTENCES, ASSISTANT_SUMMARY_INVALID_SENTENCE, askAnswerSchema, summaryResponseSchema, valueNotFitSentence, type AskAnswer, type AssistantThreadResponse, type AssistantTurnAnswer } from '@neburyx/contracts';
import { canvasOf, openWithDraft, screenOf } from './support/workspace.ts';

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
  confirmation?: { pendingId: string; plan: string; decision: string };
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
  test('gives the input the keyboard hint and the standing note as its accessible description instead of visible lines, shows the turns the server kept as compact rows above the live thread, and the new-thread card for a cleared one', async ({ page }) => {
    await openWorkspace(page, { available: true, messageWords: 1000 }, { turns: [{ seq: 1, at: '2026-11-18T10:00:00.000Z', route: 'ask', outcome: 'answered', intent: 'shared-devices', citedElements: 2, steps: 1 }, { seq: 2, at: '2026-11-18T10:05:00.000Z', route: 'refuse', outcome: 'refused', cause: 'verdict', citedElements: 0, steps: 0 }], earlierTurns: 0, previousThreadClearedAt: null });
    await open(page);
    await expect(page.getByLabel('Your message')).toHaveAccessibleDescription(/Your message goes to the model as typed\. .*Esc closes\..*The thread is cleared when the investigation closes\./);
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

  const MISFITS = [
    ['another type', { kind: 'other-type', needed: 'customer', found: 'account', citation: { ref: { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-2' }, title: 'Account AC-2', type: 'account' } }, 'Account AC-2', false],
    ['no element', { kind: 'not-found', needed: 'customer' }, undefined, false],
    ['an element the read left out', { kind: 'hidden', needed: 'customer' }, undefined, false],
    ['a step of a tool loop, with the reads of the earlier steps', { kind: 'not-found', needed: 'customer' }, undefined, true],
  ] as const;

  for (const [name, fit, title, loop] of MISFITS) {
    test(`shows the sentence of a value that does not fit, ${name}, titled Not answered, and keeps the page inside the window`, async ({ page }) => {
      await openWorkspace(page);
      const sentence = valueNotFitSentence({ kind: fit.kind, needed: 'customer', found: 'found' in fit ? fit.found : undefined, title, laterStep: loop });
      const reads = loop ? { reads: [{ tool: 'find-account', kind: 'intent', read: true, rows: 2, quality: 'exact', partial: false }] } : {};
      await answerWith(page, { status: 'answered', route: 'ask', answer: askAnswerSchema.parse({ refused: { cause: 'value-not-fit', sentence, intent: 'find-customer', valueNotFit: fit } }), ...reads } as AssistantTurnAnswer);
      await open(page);
      await page.getByLabel('Your message').fill('which customers share a phone with AC-2?');
      await page.keyboard.press('Enter');
      await expect(panel(page).getByText(sentence)).toBeVisible();
      await expect(panel(page).getByRole('heading', { name: 'Not answered' }).first()).toBeVisible();
      if (title !== undefined) await expect(panel(page).getByText(`Element: ${title} (account)`)).toBeVisible();
      if (loop) await expect(panel(page).locator('.assistant-reads').first()).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const shot = process.env['NEBURYX_UX_SHOT'];
      if (shot !== undefined) await page.screenshot({ path: shot.replace(/\.png$/, `-assistant-${loop ? 'loop' : fit.kind}.png`) });
    });
  }

  test('reads a streamed turn: asks for the stream, shows the answer as the JSON route is shown, and keeps the page inside the window', async ({ page }) => {
    await openWorkspace(page);
    let accept: string | undefined;
    await page.route((url) => url.pathname === '/v1/assistant/turns', async (route) => {
      accept = route.request().headers()['accept'];
      const lines = [{ event: 'step', n: 1, phase: 'routing' }, { event: 'step', n: 2, phase: 'answering' }, { event: 'answer', answer: REFUSE }].map((line) => `${JSON.stringify(line)}\n`).join('');
      await route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: lines });
    });
    await open(page);
    await page.getByLabel('Your message').fill('is it fraud?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeVisible();
    expect(accept).toBe('application/x-ndjson');
    await expect(panel(page).getByText('Checking the answer…')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  for (const width of [1440, 1280]) {
    test(`shows the steps of a streamed turn as they arrive at ${width} pixels: each finished read as a box, the read in progress dashed, the checking of the answer, no progress bar, then the answer`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      // the turn is answered by a response whose body the test writes a line at a time
      await page.addInitScript(() => {
        const original = window.fetch.bind(window);
        const lines: { push: (line: unknown) => void; end: () => void } = { push: () => undefined, end: () => undefined };
        (window as unknown as { __turn: typeof lines }).__turn = lines;
        window.fetch = (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          if (!url.endsWith('/v1/assistant/turns')) return original(input, init);
          const encoder = new TextEncoder();
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              lines.push = (line) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
              lines.end = () => controller.close();
            },
          });
          return Promise.resolve(new Response(body, { status: 200, headers: { 'content-type': 'application/x-ndjson' } }));
        };
      });
      await openWorkspace(page);
      await open(page);
      await page.getByLabel('Your message').fill('Which accounts share a device with AC-1?');
      await page.keyboard.press('Enter');
      const push = (line: unknown) => page.evaluate((value) => (window as unknown as { __turn: { push: (line: unknown) => void } }).__turn.push(value), line);
      await expect(panel(page).locator('.assistant-current')).toContainText('Understanding your message');
      await push({ event: 'step', n: 1, phase: 'reading', tool: 'accounts-of-a-device', label: 'Devices of an account', subject: 'AC-1', kind: 'template' });
      await expect(panel(page).locator('.assistant-current')).toContainText('Reading Devices of an account');
      await expect(panel(page).locator('.assistant-current')).toContainText('AC-1 …');
      await push({ event: 'step', n: 2, phase: 'read-done', read: { tool: 'accounts-of-a-device', label: 'Devices of an account', kind: 'template', subject: 'AC-1', read: true, rows: 2, quality: 'exact', partial: false } });
      await push({ event: 'step', n: 3, phase: 'reading', tool: 'accounts-using-a-device', label: 'Accounts using a device', subject: 'DEV-884', kind: 'template' });
      await expect(panel(page).locator('.assistant-read')).toHaveCount(1);
      await expect(panel(page).locator('.assistant-read')).toContainText('Ran Devices of an account');
      await expect(panel(page).locator('.assistant-read')).toContainText('AC-1 · 2 rows · complete');
      await expect(panel(page).locator('.assistant-current')).toContainText('Reading Accounts using a device');
      await push({ event: 'step', n: 4, phase: 'read-done', read: { tool: 'accounts-using-a-device', label: 'Accounts using a device', kind: 'template', subject: 'DEV-884', read: true, rows: 3, quality: 'exact', partial: false } });
      await push({ event: 'step', n: 5, phase: 'answering' });
      await expect(panel(page).locator('.assistant-read')).toHaveCount(2);
      await expect(panel(page).locator('.assistant-current')).toContainText('Checking the answer…');
      await expect(panel(page).locator('.assistant-current')).toContainText('Every sentence must cite something that was read.');
      await expect(panel(page).locator('.ask-progress, progress, [role="progressbar"]')).toHaveCount(0);
      const box = await panel(page).boundingBox();
      for (const target of [panel(page).locator('.assistant-current'), panel(page).getByRole('button', { name: 'Cancel' })]) {
        const inner = await target.boundingBox();
        expect(box !== null && inner !== null && inner.x >= box.x && inner.x + inner.width <= box.x + box.width).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await push({ event: 'answer', answer: REFUSE });
      await page.evaluate(() => (window as unknown as { __turn: { end: () => void } }).__turn.end());
      await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeVisible();
      await expect(panel(page).locator('.assistant-progress')).toHaveCount(0);
    });
  }

  test('sends the keys of the elements selected on the canvas with a typed message, each message with the selection it was typed with, and the page stays inside the window at the width of each project', async ({ page }) => {
    await openWorkspace(page);
    await openWithDraft(page, ['AC-1', 'AC-2'], (index) => ({ x: -index * 200, y: index * 120 }));
    await page.reload();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '2');
    const sent = await answerWith(page, REFUSE);
    const keyOf = (id: string) => JSON.stringify(['node', 'banking-demo', 'account', id]);
    const first = await screenOf(page, 'AC-1');
    await page.mouse.click(first.x, first.y);
    await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    await open(page);
    await page.getByLabel('Your message').fill('what is this?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeVisible();
    expect((sent[0] as { selectionKeys?: string[] } | undefined)?.selectionKeys).toEqual([keyOf('AC-1')]);
    expect(sent[0]?.viewElementKeys).toEqual(expect.arrayContaining([keyOf('AC-1'), keyOf('AC-2')]));
    const second = await screenOf(page, 'AC-2');
    await page.mouse.click(second.x, second.y);
    await page.getByLabel('Your message').fill('and this one?');
    await page.keyboard.press('Enter');
    await expect.poll(() => sent.length).toBe(2);
    expect((sent[1] as { selectionKeys?: string[] } | undefined)?.selectionKeys).toEqual([keyOf('AC-2')]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
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
    await expect(panel(page).getByText('Input is disabled while it runs. Cancel stops the request; nothing more is read once it is stopped.')).toBeVisible();
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
    const hint = panel(page).getByText('Input is disabled while it runs. Cancel stops the request; nothing more is read once it is stopped.');
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
    test(`starts the panel 16 pixels under the header at ${width} pixels, keeps the sources closed, and opens the list and selects a cited element from the keyboard`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const cited = { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' };
      await answerWith(page, {
        status: 'answered',
        route: 'view',
        blocks: [{ kind: 'sentences', sentences: [{ text: 'Account AC-1 is in view.', cites: ['n1'] }] }],
        citations: [{ key: 'n1', kind: 'entity', ref: cited }],
        coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 1 of the 1 shown elements.' },
        model: 'claude-sonnet-5-5',
        calls: 2,
      });
      await open(page);
      const headerBox = await header(page).boundingBox();
      const panelBox = await page.locator('aside.floating-panel').boundingBox();
      expect(headerBox !== null && panelBox !== null && Math.round(panelBox.y - (headerBox.y + headerBox.height))).toBe(16);
      await page.getByLabel('Your message').fill('what is in view?');
      await page.keyboard.press('Enter');
      const field = page.getByLabel('Your message');
      expect((await field.boundingBox())?.height).toBe(40);
      expect(Math.round(panelBox?.height ?? 0)).toBe(820);
      await field.fill('one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twenty-one twenty-two twenty-three twenty-four twenty-five twenty-six');
      const grown = (await field.boundingBox())?.height ?? 0;
      expect(grown > 40 && grown <= 120).toBe(true);
      await field.fill('');
      await page.setViewportSize({ width, height: 560 });
      await expect(page.getByLabel('Your message')).toBeInViewport();
      const shorter = await page.locator('aside.floating-panel').boundingBox();
      expect(shorter !== null && shorter.y + shorter.height <= 560).toBe(true);
      await page.setViewportSize({ width, height: 900 });
      const control = panel(page).getByRole('button', { name: 'Sources · 1' });
      await expect(control).toHaveAttribute('aria-expanded', 'false');
      await expect(panel(page).getByRole('button', { name: /^Sources: / })).toHaveCount(0);
      await control.focus();
      await page.keyboard.press('Space');
      await expect(control).toHaveAttribute('aria-expanded', 'true');
      await page.keyboard.press('Tab');
      await expect(panel(page).getByRole('button', { name: /^Sources: / })).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    });
  }

  test('groups seven relationships of one shape in the open list, expands the group and shows the rest, and selects a member from the keyboard', async ({ page }) => {
    const neighbors = Array.from({ length: 7 }, (_, index) => `N-${index + 1}`);
    const total = { value: 7, quality: 'exact', scope: 'relationships' };
    await page.route((url) => url.pathname === '/v1/graph/preview-expansion', (route) => {
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string } };
      return route.fulfill({ json: { ref: { sourceId: body.sourceId, ...body.ref }, total, byType: [], byNeighborType: [{ entityType: 'account', count: total }], warnings: [], pageSize: 25, heavyOpThreshold: 500 } });
    });
    await page.route((url) => url.pathname === '/v1/graph/expand', (route) => {
      const body = route.request().postDataJSON() as { sourceId: string; ref: { entityType: string; stableId: string }; neighborTypes: string[] };
      const anchor = { sourceId: body.sourceId, ...body.ref };
      const nodes = neighbors.map((stableId) => ({ ref: { sourceId: body.sourceId, entityType: 'account', stableId }, display: { title: `account ${stableId}`, type: 'account' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } }));
      const edges = nodes.map((held) => ({ ref: { sourceId: body.sourceId, type: 'LINK', from: 'account', to: 'account', stableId: `R-${held.ref.stableId}` }, from: anchor, to: held.ref, type: 'LINK', direction: 'out', semantics: 'stored', properties: [], evidenceRefs: [], qualityFlags: [] }));
      return route.fulfill({ json: { ref: anchor, pageSize: 25, nodes, edges, pages: body.neighborTypes.map((neighborType) => (neighborType === 'account' ? { neighborType, returned: 7, hasMore: false, matchingTotal: total } : { neighborType, returned: 0, hasMore: false, matchingTotal: { value: 0, quality: 'exact', scope: 'relationships' } })), warnings: [] } });
    });
    await page.route((url) => url.pathname === '/v1/graph/coverage', (route) => route.fulfill({ json: { notRetrieved: { value: 0, quality: 'exact', scope: 'not yet retrieved' }, uncounted: 0 } }));
    await openWorkspace(page);
    await canvasOf(page).focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Space');
    await page.keyboard.press('ContextMenu');
    await page.getByRole('menu').first().getByRole('menuitem', { name: 'Expand by type', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.getByRole('complementary', { name: 'Expand relationships' }).getByRole('button', { name: /^Load .* per type$/ }).click();
    await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '8');
    const refs = neighbors.map((stableId) => ({ sourceId: 'banking-demo', type: 'LINK', from: 'account', to: 'account', stableId: `R-${stableId}` }));
    await answerWith(page, {
      status: 'answered',
      route: 'view',
      blocks: [{ kind: 'sentences', sentences: [{ text: 'Seven relationships join AC-1 to other accounts.', cites: refs.map((_, index) => `r${index + 1}`) }] }],
      citations: refs.map((ref, index) => ({ key: `r${index + 1}`, kind: 'relationship' as const, ref })),
      coverage: { retrieval: '8 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 7 of the 7 shown relationships.' },
      model: 'claude-sonnet-5-5',
      calls: 2,
    });
    await open(page);
    await page.getByLabel('Your message').fill('what joins AC-1?');
    await page.keyboard.press('Enter');
    const control = panel(page).getByRole('button', { name: 'Sources · 7' });
    await control.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText('7 sources, grouped by shape')).toBeVisible();
    const group = panel(page).getByRole('button', { name: /^7 .*LINK, \[1–7\]$/ });
    await expect(group).toHaveAttribute('aria-expanded', 'false');
    await group.focus();
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('button', { name: /^Sources: / })).toHaveCount(5);
    await expect(panel(page).getByText('2 more in this group')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Show all' }).focus();
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('button', { name: /^Sources: / })).toHaveCount(7);
    await expect(panel(page).getByRole('button', { name: /^Sources: 6, / })).toBeFocused();
    const described = () => canvasOf(page).evaluate((element) => document.getElementById(element.getAttribute('aria-describedby') ?? '')?.textContent ?? '');
    const before = await described();
    await page.keyboard.press('Enter');
    expect(before).toContain('14 selected');
    await expect.poll(described).toContain('; 1 selected');
  });

  for (const width of [1440, 1280]) {
    test(`shows an answer from the view at ${width} pixels with its tags, markers, sources and the two lines of coverage, and selects the cited element`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const cited = { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' };
      const answer: AssistantTurnAnswer = {
        status: 'answered',
        route: 'view',
        blocks: [{ kind: 'sentences', sentences: [{ text: 'Account AC-1 is in view.', cites: ['n1'] }] }],
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

  for (const width of [1440, 1280, 390]) {
    test(`has the structure of a table answer at ${width} pixels: the title, a header with a Cite column, a chip on every row, the fold line, the notice, the sources and the coverage, and never scrolls the page sideways`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const cited = { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' };
      const answer: AssistantTurnAnswer = {
        status: 'answered',
        route: 'view',
        blocks: [{ kind: 'table', table: { title: 'Accounts · 12 rows', columns: ['Element', 'A rather long column label to widen it', 'Another long column label'], rows: Array.from({ length: 12 }, (_, index) => ({ cells: [`row-${index + 1}`, `a long cell text for row ${index + 1} of the table`, 'value'], cites: ['n1'] })), note: 'Each row selects its elements on the graph.', moreNotShown: 3, droppedRows: 1 } }],
        citations: [{ key: 'n1', kind: 'entity', ref: cited }],
        coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: '12 of 15 accounts in view shown · exact' },
        model: 'claude-sonnet-5-5',
        calls: 2,
      };
      await answerWith(page, answer);
      await open(page);
      await page.getByLabel('Your message').fill('show them as a table');
      await page.keyboard.press('Enter');
      const table = panel(page).getByRole('table', { name: 'Accounts · 12 rows' });
      await expect(table).toBeVisible();
      await expect(table.getByRole('columnheader', { name: 'Source' })).toBeVisible();
      await expect(table.getByRole('row')).toHaveCount(1 + 3 + 1 + 1);
      await expect(table.getByRole('button', { name: /^Citation 1, / })).toHaveCount(4);
      await expect(table.getByRole('button', { name: '… 8 more rows …' })).toBeVisible();
      await expect(panel(page).getByText('More not shown')).toBeVisible();
      await expect(panel(page).getByText('12 rows are shown. 3 more rows were not shown. Narrow the view or ask for a smaller set.')).toBeVisible();
      await expect(panel(page).getByText('Sources · 1')).toBeVisible();
      await expect(panel(page).getByText('12 of 15 accounts in view shown · exact')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }

  for (const width of [1440, 1280]) {
    test(`shows the refusal of a verdict with what the investigation connects at ${width} pixels, and selects the cited element`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const cited = { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' };
      const overview: AssistantTurnAnswer = {
        status: 'answered',
        route: 'refuse',
        cause: 'verdict',
        sentence: ASSISTANT_REFUSAL_SENTENCES.verdict,
        overview: { sentences: [{ text: 'Account AC-1 is in view.', cites: ['n1'] }], citations: [{ key: 'n1', kind: 'entity', ref: cited }], coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: 'The overview cites 1 of the 1 shown elements.' }, model: 'claude-sonnet-5-5' },
      };
      await answerWith(page, overview);
      await open(page);
      await page.getByLabel('Your message').fill('is this customer laundering money?');
      await page.keyboard.press('Enter');
      await expect(panel(page).getByRole('heading', { name: 'Not answered' })).toBeVisible();
      await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeVisible();
      await expect(panel(page).getByRole('heading', { name: 'What the investigation connects' })).toBeVisible();
      await expect(panel(page).getByText('AI-drafted')).toBeVisible();
      await expect(panel(page).getByText('Account AC-1 is in view.')).toBeVisible();
      await expect(panel(page).getByText('1 shown · 0 not yet retrieved (exact)')).toBeVisible();
      await expect(panel(page).getByText('An overview of the view, not an assessment.')).toBeVisible();
      await expect(panel(page).getByRole('button', { name: 'Open Filters' })).toBeVisible();
      await expect(panel(page).getByText(/^Sources · /)).toHaveCount(0);
      const box = await panel(page).boundingBox();
      for (const target of [panel(page).locator('.assistant-overview'), panel(page).getByRole('button', { name: 'Open Filters' })]) {
        const inner = await target.boundingBox();
        expect(box !== null && inner !== null && inner.x >= box.x && inner.x + inner.width <= box.x + box.width).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      await panel(page).getByRole('button', { name: /^Citation 1, / }).first().click();
      await expect(page.getByRole('complementary', { name: 'Inspector' })).toBeVisible();
    });

    test(`shows the plain refusal alone at ${width} pixels when no overview could be drawn`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      await answerWith(page, REFUSE);
      await open(page);
      await page.getByLabel('Your message').fill('is this customer laundering money?');
      await page.keyboard.press('Enter');
      await expect(panel(page).getByRole('heading', { name: 'Not answered' })).toBeVisible();
      await expect(panel(page).getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeVisible();
      await expect(panel(page).getByRole('button', { name: 'Open Filters' })).toBeVisible();
      await expect(panel(page).getByRole('heading', { name: 'What the investigation connects' })).toHaveCount(0);
      await expect(panel(page).getByText('AI-drafted')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }

  for (const width of [1440, 1280]) {
    test(`shows an About chip for the meaning of a type at ${width} pixels, opens the operator's description as text and selects nothing, and shows the plain card of a type with no description`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const cited = { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' };
      const description = 'A bank account that holds a balance and takes part in transfers and payments.';
      const answer: AssistantTurnAnswer = {
        status: 'answered',
        route: 'view',
        blocks: [{ kind: 'sentences', sentences: [{ text: 'An account holds a balance and takes part in transfers and payments.', cites: ['m1'] }, { text: 'Account AC-1 is in view.', cites: ['n1'] }] }],
        citations: [{ key: 'n1', kind: 'entity', ref: cited }, { key: 'm1', kind: 'description', typeKind: 'entity', type: 'Account', description }],
        coverage: { retrieval: '1 shown · 0 not yet retrieved (exact)', summary: 'The draft cites 1 of the 1 shown elements.' },
        noDescription: 'The mapping has no description for Gizmo, so I cannot say what it means.',
        model: 'claude-sonnet-5-5',
        calls: 2,
      };
      await answerWith(page, answer);
      await open(page);
      await page.getByLabel('Your message').fill('what is an account and a gizmo?');
      await page.keyboard.press('Enter');
      const chip = panel(page).getByRole('button', { name: /^About Account:/ });
      await expect(chip).toBeVisible();
      await expect(panel(page).getByText(description)).toHaveCount(0);
      await chip.click();
      await expect(panel(page).getByText(description)).toBeVisible();
      await expect(panel(page).getByText('The operator’s description of the type, not a read of the source')).toBeVisible();
      await expect(panel(page).getByText('The mapping has no description for Gizmo, so I cannot say what it means.')).toBeVisible();
      await expect(panel(page).getByText('Sources · 1')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const box = await panel(page).boundingBox();
      expect(box === null ? 0 : box.x + box.width).toBeLessThanOrEqual(width);
    });

    test(`shows what types mean as the operator's text at ${width} pixels with no AI-drafted tag, and the fixed sentence for the type with none`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const sentence = 'The mapping has no description for Gizmo, so I cannot say what it means.';
      const description = 'A widget is a small unit that holds up to 12 parts, with a_very_long_word_'.concat('x'.repeat(80));
      await answerWith(page, { status: 'meaning', described: [{ typeKind: 'entity', type: 'Widget', description }], noDescription: { sentence, names: ['Gizmo'] } });
      await open(page);
      await page.getByLabel('Your message').fill('what are a widget and a gizmo?');
      await page.keyboard.press('Enter');
      await expect(panel(page).getByText('About Widget')).toBeVisible();
      await expect(panel(page).getByText(description)).toBeVisible();
      await expect(panel(page).getByText(sentence)).toBeVisible();
      await expect(panel(page).getByText('AI-drafted')).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });

    test(`shows a type with no description as a plain card at ${width} pixels: the fixed sentence, no AI-drafted tag and no sources`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const sentence = 'The mapping has no description for Gizmo, so I cannot say what it means.';
      await answerWith(page, { status: 'no-description', route: 'view', sentence, names: ['Gizmo'] });
      await open(page);
      await page.getByLabel('Your message').fill('what is a gizmo?');
      await page.keyboard.press('Enter');
      await expect(panel(page).getByText(sentence)).toBeVisible();
      await expect(panel(page).getByText('what is a gizmo?')).toBeVisible();
      await expect(panel(page).getByText('AI-drafted')).toHaveCount(0);
      await expect(panel(page).getByText(/^Sources/)).toHaveCount(0);
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
        blocks: [{ kind: 'sentences', sentences: [{ text: 'Account AC-1 shares a device with account AC-2.', cites: ['r1', 'r2'] }] }],
        citations: [
          { key: 'r1', kind: 'entity', ref: { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' } },
          { key: 'r2', kind: 'entity', ref: { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-2' } },
        ],
        coverage: { retrieval: '2 shown · 0 not yet retrieved (exact)', summary: 'The answer cites 2 of the 2 elements the reads returned.' },
        model: 'claude-sonnet-5-5',
        calls: 4,
        steps: 2,
        reads: [
          { tool: 'shared-devices', kind: 'intent', subject: 'AC-1', read: true, rows: 12, quality: 'exact', partial: false },
          { tool: 'fan-out', kind: 'pattern', subject: 'AC-1', read: true, rows: 25, quality: 'lowerBound', partial: false },
        ],
      };
      await answerWith(page, answer);
      await open(page);
      await page.getByLabel('Your message').fill('who shares a device with AC-1?');
      await page.keyboard.press('Enter');
      await expect(panel(page).getByText('AI-drafted')).toBeVisible();
      await expect(panel(page).getByText('Account AC-1 shares a device with account AC-2.')).toBeVisible();
      await expect(panel(page).getByText('Steps · 2')).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Answer from the reads' })).toBeFocused();
      await expect(panel(page).getByText('Ran Shared devices')).toBeHidden();
      await panel(page).getByText('Steps · 2').click();
      await expect(panel(page).getByText('Ran Shared devices')).toBeVisible();
      await expect(panel(page).getByText('Folder intent')).toBeVisible();
      await expect(panel(page).getByText('AC-1 · 12 rows · complete')).toBeVisible();
      await expect(panel(page).getByText('from AC-1 · ≥ 25 rows · complete')).toBeVisible();
      await expect(panel(page).getByText('Lower bound', { exact: true })).toBeVisible();
      await expect(panel(page).getByText('Sources · 2')).toBeVisible();
      await expect(panel(page).getByText('The answer cites 2 of the 2 elements the reads returned.')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      const box = await panel(page).boundingBox();
      expect(box !== null && box.y >= 0 && box.y + box.height <= 900).toBe(true);
    });
  }

  for (const width of [1440, 1280]) {
    test(`shows a heavy step that waits for the analyst at ${width} pixels, confirms it with the plan and the view of the turn, and goes on in the same turn`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const plan = `${'1'.repeat(10)}.${'a'.repeat(120)}.${'b'.repeat(64)}`;
      const waiting: AssistantTurnAnswer = {
        status: 'confirmation',
        pendingId: '0192f000-0000-7000-8000-0000000000a1',
        plan,
        step: { tool: 'relationships-of-a-device', kind: 'template', subject: 'DEV-884', count: { quality: 'lowerBound', value: 1200 }, page: 25 },
        reads: [{ tool: 'devices-of-an-account', kind: 'template', subject: 'ACC-71825', read: true, rows: 2, quality: 'exact', partial: false }],
      };
      const done: AssistantTurnAnswer = {
        status: 'answered',
        route: 'ask',
        blocks: [{ kind: 'sentences', sentences: [{ text: 'Device DEV-884 is used by two accounts.', cites: ['s2'] }] }],
        citations: [],
        coverage: { retrieval: 'read 1: 2 shown · exact; read 2: 25 shown · ≥ 1,200 not yet retrieved', summary: 'The answer cites 0 of the 25 elements the reads returned.' },
        model: 'claude-sonnet-5-5',
        calls: 4,
        steps: 2,
        reads: [
          { tool: 'devices-of-an-account', kind: 'template', subject: 'ACC-71825', read: true, rows: 2, quality: 'exact', partial: false },
          { tool: 'relationships-of-a-device', kind: 'template', subject: 'DEV-884', read: true, rows: 1200, quality: 'lowerBound', partial: true },
        ],
      };
      const sent = await answerWith(page, (body) => (body.confirmation === undefined ? waiting : done));
      await open(page);
      await page.getByLabel('Your message').fill('Who else uses DEV-884?');
      await page.keyboard.press('Enter');
      const title = page.getByRole('heading', { name: 'Read Relationships of a device for DEV-884?' });
      await expect(title).toBeFocused();
      await expect(panel(page).getByText('Waiting for you')).toBeVisible();
      await expect(panel(page).getByText('This read of DEV-884 is larger than one page. This would read one page of 25 rows.')).toBeVisible();
      await expect(panel(page).getByText('≥ 1,200 rows')).toBeVisible();
      await expect(panel(page).getByText('Ran Devices of an account')).toBeVisible();
      await expect(panel(page).getByText('Nothing more runs until you choose. Cancel stops the turn.')).toBeVisible();
      for (const name of ['Confirm', 'Skip', 'Cancel']) await expect(panel(page).getByRole('button', { name })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
      // Esc closes the panel, sends nothing, and the card is there again when the panel is opened
      const requestsBefore = sent.length;
      await page.keyboard.press('Escape');
      await expect(panel(page)).toHaveCount(0);
      expect(sent.length).toBe(requestsBefore);
      await open(page);
      await expect(page.getByRole('heading', { name: 'Read Relationships of a device for DEV-884?' })).toBeVisible();
      await panel(page).getByRole('button', { name: 'Confirm' }).click();
      await expect(panel(page).getByText('Device DEV-884 is used by two accounts.')).toBeVisible();
      expect(sent[1]).toMatchObject({ message: 'Who else uses DEV-884?', viewElementKeys: sent[0]?.viewElementKeys, confirmation: { pendingId: '0192f000-0000-7000-8000-0000000000a1', plan, decision: 'confirm' } });
      await expect(panel(page).getByRole('button', { name: 'Confirm' })).toHaveCount(0);
    });

    test(`shows the stop of a limit with the reads open above its card at ${width} pixels`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await openWorkspace(page);
      const stop: AssistantTurnAnswer = {
        status: 'limit',
        limit: 'steps',
        sentence: 'This turn reached its limit for reads, so it stopped. What was read is shown above.',
        reads: [
          { tool: 'devices-of-an-account', kind: 'template', subject: 'ACC-48291', read: true, rows: 2, quality: 'exact', partial: false },
          { tool: 'accounts-using-a-device', kind: 'template', subject: 'DEV-884', read: true, rows: 3, quality: 'exact', partial: false },
        ],
      };
      await answerWith(page, stop);
      await open(page);
      await page.getByLabel('Your message').fill('Trace every device and account around ACC-48291');
      await page.keyboard.press('Enter');
      await expect(page.getByRole('heading', { name: 'Stopped at a limit' })).toBeFocused();
      await expect(panel(page).getByText('This turn reached its limit for reads, so it stopped. What was read is shown above.')).toBeVisible();
      await expect(panel(page).getByText('Ask a narrower question to go further. Confirming a step never lifts a limit.')).toBeVisible();
      await expect(panel(page).getByText('Ran Devices of an account')).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  }

  for (const width of [1440, 1280]) test(`keeps the page and the panel in place when a long answer from the view arrives at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspace(page);
    const ids = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7', 'AC-8', 'AC-9', 'AC-10'];
    const answer: AssistantTurnAnswer = {
      status: 'answered',
      route: 'view',
      blocks: [{ kind: 'sentences', sentences: ids.map((id, index) => ({ text: `Account ${id} is in view, number ${index + 1} of ${ids.length}.`, cites: [`n${index + 1}`] })) }],
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
    await panel(page).getByRole('button', { name: 'Sources · 10' }).click();
    await expectHeaderStays(page);
  });

  for (const width of [1440, 1280]) test(`keeps the workspace in place when a refusal follows a long answer from the view at ${width} pixels`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openWorkspace(page);
    const ids = ['AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7', 'AC-8', 'AC-9', 'AC-10'];
    const long: AssistantTurnAnswer = {
      status: 'answered',
      route: 'view',
      blocks: [{ kind: 'sentences', sentences: ids.map((id, index) => ({ text: `Account ${id} is in view, number ${index + 1} of ${ids.length}.`, cites: [`n${index + 1}`] })) }],
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
    await panel(page).getByRole('button', { name: 'Sources · 10' }).click();
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

  const summaryDraft = (sourceId: string) =>
    summaryResponseSchema.parse({
      status: 'ok',
      sentences: [{ text: 'AC-1 is an account.', cites: ['n1'], storable: true }],
      citations: [{ key: 'n1', kind: 'entity', ref: { sourceId, entityType: 'account', stableId: 'AC-1' } }],
      coverage: { retrieval: '1 shown · ~38 not yet retrieved (estimated)', summary: 'The draft cites 1 of the 1 shown elements' },
      removedCount: 0,
      sent: 'n1 account AC-1',
      model: 'stub-model',
      calls: 1,
      summaryToken: 'v1.tok',
    });

  async function draftThenAsk(page: Page): Promise<void> {
    await openWorkspace(page);
    await page.route((url) => url.pathname === '/v1/summary', async (route) => route.fulfill({ json: summaryDraft((route.request().postDataJSON() as { sourceId: string }).sourceId) }));
    await header(page).getByRole('button', { name: /^Summarize/ }).click();
    const summaryPanel = page.getByRole('complementary', { name: 'AI case summary' });
    await expect(summaryPanel.getByRole('button', { name: 'Ask about this summary' })).toBeInViewport({ ratio: 1 });
    await expect(summaryPanel.getByText('Opens the Assistant with this summary as context, for you and this investigation only.')).toBeVisible();
    await summaryPanel.getByRole('button', { name: 'Ask about this summary' }).click();
    await expect(panel(page)).toBeVisible();
    await expect(summaryPanel).toHaveCount(0);
    await expect(page.getByLabel('Your message')).toBeFocused();
  }

  for (const width of [1440, 1280]) test(`hands the summary to the thread at ${width} pixels: the context block and the chip are in view, and the message carries the token while the chip is on`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const view: AssistantTurnAnswer = {
      status: 'answered',
      route: 'view',
      blocks: [{ kind: 'sentences', sentences: [{ text: 'AC-1 is an account.', cites: ['n1'] }] }],
      citations: [{ key: 'n1', kind: 'entity', ref: { sourceId: 'banking-demo', entityType: 'account', stableId: 'AC-1' } }],
      coverage: { retrieval: '1 shown · ~38 not yet retrieved (estimated)', summary: 'The draft cites 1 of the 1 shown elements.', summaryCited: "Cites the summary's sentence 1." },
      summarySentencesCited: [1],
      model: 'stub-model',
      calls: 2,
    };
    await draftThenAsk(page);
    const sent = await answerWith(page, view);
    const block = panel(page).getByRole('region', { name: 'AI case summary' });
    await expect(block).toBeInViewport({ ratio: 1 });
    await expect(block.getByText(/^1 sentence · drafted \d\d:\d\d UTC · Model: stub-model$/)).toBeVisible();
    await expect(block.getByText('AC-1 is an account.')).toBeVisible();
    await expect(block.getByText('Used for this thread only. It is dropped if masking, policy or access changes.')).toBeVisible();
    await expect(panel(page).getByText('Asking about: AI case summary')).toBeInViewport({ ratio: 1 });
    await expect(page.getByPlaceholder('Ask a follow-up…')).toBeInViewport({ ratio: 1 });
    await page.getByLabel('Your message').fill('which claim rests on the account?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByText("Cites the summary's sentence 1.")).toBeInViewport({ ratio: 1 });
    expect(sent).toHaveLength(1);
    expect((sent[0] as unknown as { summaryToken?: string }).summaryToken).toBe('v1.tok');
    await panel(page).getByRole('button', { name: 'Stop asking about the AI case summary' }).click();
    await expect(page.getByPlaceholder('Ask about this investigation…')).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  for (const width of [1440, 1280]) test(`shows the summary that can no longer be used as a card at ${width} pixels, removes the chip and gives the message back`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await draftThenAsk(page);
    await answerWith(page, { status: 'summary-invalid', sentence: ASSISTANT_SUMMARY_INVALID_SENTENCE });
    await page.getByLabel('Your message').fill('which claim rests on the account?');
    await page.keyboard.press('Enter');
    await expect(panel(page).getByRole('heading', { name: 'Summary no longer attached' })).toBeInViewport({ ratio: 1 });
    await expect(panel(page).getByText(ASSISTANT_SUMMARY_INVALID_SENTENCE)).toBeVisible();
    await expect(panel(page).getByText('Asking about: AI case summary')).toHaveCount(0);
    await expect(panel(page).getByText('No longer attached', { exact: true })).toBeVisible();
    await expect(page.getByLabel('Your message')).toHaveValue('which claim rests on the account?');
  });
});
