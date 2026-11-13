import { expect, type Locator, type Page } from '@playwright/test';
import { canvasOf } from './workspace.ts';

export const ASK_HASH = 'a'.repeat(64);

export const askControl = (page: Page): Locator => page.getByRole('banner', { name: 'Investigation' }).getByRole('button', { name: 'Ask', exact: true });
export const askPanel = (page: Page): Locator => page.locator('.ask-panel');
export const askField = (page: Page): Locator => askPanel(page).getByRole('textbox', { name: 'Your question' });

export interface AskRequests {
  /** The bodies of the requests to the plan endpoint, in order. */
  readonly bodies: Array<Record<string, unknown>>;
}

/**
 * Answers the plan endpoint from the question text, so a spec can reach each state without a server behind it: a question with `zorvat` has a
 * blocked word, one with `Qux` needs a clarification, and any other is previewed with the placeholder in place of `AC-1`.
 */
export async function scriptAsk(page: Page): Promise<AskRequests> {
  const seen: AskRequests = { bodies: [] };
  await page.route((url) => url.pathname === '/v1/me', async (route) => {
    const answer = await route.fetch();
    await route.fulfill({ response: answer, json: { ...(await answer.json()), edition: 'enterprise' } });
  });
  await page.route((url) => url.pathname === '/v1/ask/plan', async (route) => {
    const body: Record<string, unknown> = route.request().postDataJSON();
    seen.bodies.push(body);
    const message = typeof body.message === 'string' ? body.message : '';
    const at = message.indexOf('zorvat');
    if (at >= 0 && body.resolutions === undefined) return route.fulfill({ json: { blocked: { tokens: [{ text: 'zorvat', start: at, end: at + 6 }] } } });
    const clarify = message.indexOf('Qux');
    if (clarify >= 0 && body.resolutions === undefined) {
      const ref = (stableId: string) => ({ sourceId: 'banking-demo', entityType: 'account', stableId });
      return route.fulfill({ json: { clarification: { start: clarify, end: clarify + 3, choices: [ref('AC-1'), ref('AC-2')], count: { value: 2, quality: 'exact', scope: 'exact matches' }, unreferenced: 0 } } });
    }
    if (body.send === true) return route.fulfill({ json: { plan: { kind: 'unsupported', family: 'other', reason: 'Ask has no way to answer this question.' } } });
    return route.fulfill({ json: { preview: 'Which accounts share the same device as ‹account#1›?', previewHash: ASK_HASH } });
  });
  return seen;
}

/** Opens an entity of the banking demo and then the Ask panel from the header. */
export async function openAsk(page: Page): Promise<void> {
  await page.goto('/dev/open-entity');
  await page.getByRole('button', { name: 'banking-demo' }).click();
  const form = page.getByRole('form', { name: 'Open an entity' });
  await form.getByLabel('Stable ID').fill('AC-1');
  await form.getByRole('button', { name: 'Open' }).click();
  await expect(canvasOf(page)).toHaveAttribute('data-drawn-entities', '1');
  await askControl(page).click();
  await expect(askPanel(page)).toBeVisible();
}

export async function previewQuestion(page: Page, question: string): Promise<void> {
  await askField(page).fill(question);
  await askPanel(page).getByRole('button', { name: 'Preview' }).click();
}
