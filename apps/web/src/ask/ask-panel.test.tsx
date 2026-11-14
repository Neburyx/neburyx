import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASK_REFUSAL_CAUSES, ASK_REFUSAL_SENTENCES, askAnswerSchema, type AskAnswer, type AskContinueRequest, type AskQuestionRequest } from '@neburyx/contracts';
import { fakeClient } from '../api/fake-client.js';
import type { ApiResult } from '../api/client.js';
import { ApiClientProvider } from '../api/client-context.js';
import { createClientState } from '../state/client-state.js';
import { ClientStateProvider } from '../state/context.js';
import { failure, heavyRun, okRun } from '../patterns/patterns-kit.js';
import { createToolRegistry, ToolsProvider, type ToolRegistry } from '../workspace/tool-registry.js';
import { AskPanel } from './ask-panel.js';
import { ASK_COPY } from './copy.js';
import { causeTag } from './text.js';
import { AskSessionProvider, createAskSession } from './ask-session.js';

afterEach(cleanup);

const ANSWER: AskAnswer = { answered: { intent: 'shared-devices', entities: { account: 'acc-1' }, outcome: 'complete', result: { templateId: 'shared-attribute', result: okRun(['acc-2']) } } };

function harness(ask: (request: AskQuestionRequest, signal: AbortSignal | undefined) => Promise<ApiResult<AskAnswer>>, onContinue: (request: AskContinueRequest) => Promise<ApiResult<AskAnswer>> = async () => ({ ok: true, value: ANSWER })) {
  const state = createClientState();
  state.bindSource('a');
  const session = createAskSession();
  const tools: ToolRegistry = createToolRegistry();
  const sent: AskQuestionRequest[] = [];
  const continued: AskContinueRequest[] = [];
  const client = fakeClient({
    askContinue: async (request) => {
      continued.push(request);
      return onContinue(request);
    },
    ask: async (request, signal) => {
      sent.push(request);
      return ask(request, signal);
    },
  });
  const tree = (open: boolean) => (
    <ApiClientProvider client={client}>
      <ClientStateProvider state={state}>
        <ToolsProvider registry={tools}>
          <AskSessionProvider value={session}>{open ? <AskPanel onClose={() => undefined} /> : null}</AskSessionProvider>
        </ToolsProvider>
      </ClientStateProvider>
    </ApiClientProvider>
  );
  return { tree, sent, continued, session, state, tools };
}

describe('the Ask panel: a typed question', () => {
  it('disables Send for a blank or too long question and enables it for one in range', async () => {
    const h = harness(async () => ({ ok: true, value: ANSWER }));
    render(h.tree(true));
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    await userEvent.type(screen.getByLabelText('Your question'), '   ');
    expect(send.disabled).toBe(true);
    await userEvent.clear(screen.getByLabelText('Your question'));
    await userEvent.type(screen.getByLabelText('Your question'), 'who shares a device?');
    expect(send.disabled).toBe(false);
  });

  it('sends the question as typed with the source on Enter, shows the answer, and keeps Shift+Enter for a new line', async () => {
    const h = harness(async () => ({ ok: true, value: ANSWER }));
    render(h.tree(true));
    const field = screen.getByLabelText('Your question');
    await userEvent.type(field, 'who shares{Shift>}{Enter}{/Shift}a device?{Enter}');
    expect(h.sent).toEqual([{ sourceId: 'a', question: 'who shares\na device?' }]);
    expect(await screen.findByRole('heading', { name: 'Answer ready' })).toBeTruthy();
    expect(screen.getByText('Shared devices')).toBeTruthy();
  });

  it('sends one question at a time and says it is asking', async () => {
    let finish: (value: ApiResult<AskAnswer>) => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (finish = resolve)));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}{Enter}');
    expect(h.sent).toHaveLength(1);
    expect(screen.getByRole('status').textContent).toBe('Asking…');
    finish({ ok: true, value: ANSWER });
    expect(await screen.findByRole('heading', { name: 'Answer ready' })).toBeTruthy();
  });

  it('keeps the question and the answer while the panel is closed', async () => {
    const h = harness(async () => ({ ok: true, value: ANSWER }));
    const view = render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    await screen.findByRole('heading', { name: 'Answer ready' });
    view.rerender(h.tree(false));
    view.rerender(h.tree(true));
    expect((screen.getByLabelText('Your question') as HTMLTextAreaElement).value).toBe('q');
    expect(screen.getByRole('heading', { name: 'Answer ready' })).toBeTruthy();
  });

  it('cancels a question that is out and shows no answer for it', async () => {
    const h = harness(() => new Promise(() => undefined));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('heading', { name: 'Cancelled' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Answer ready' })).toBeNull();
  });
});

describe('the Ask panel: a refusal', () => {
  it.each(ASK_REFUSAL_CAUSES)('shows the fixed sentence, the cause tag, the question as typed and the chips in order: %s', async (cause) => {
    const h = harness(async () => ({ ok: true, value: { refused: { cause, sentence: ASK_REFUSAL_SENTENCES[cause] } } }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    expect(await screen.findByRole('heading', { name: 'Ask did not answer' })).toBeTruthy();
    expect(screen.getByText(ASK_REFUSAL_SENTENCES[cause])).toBeTruthy();
    expect(screen.getByText(causeTag(cause))).toBeTruthy();
    expect(document.querySelector('.ask-typed-text')?.textContent).toBe('q');
    expect([...document.querySelectorAll('.ask-chip')].map((chip) => chip.textContent)).toEqual(['Open Filters', 'Search by stable ID', 'Expand']);
    expect((screen.getByLabelText('Your question') as HTMLTextAreaElement).value).toBe('q');
  });

  it('puts Open Paths first only when the Paths tool is registered as an action, and runs it', async () => {
    const h = harness(async () => ({ ok: true, value: { refused: { cause: 'no-intent', sentence: ASK_REFUSAL_SENTENCES['no-intent'] } } }));
    let activated = 0;
    h.tools.register({ id: 'paths', label: 'Paths', icon: null, order: 30, kind: { type: 'action', activate: () => (activated += 1) } });
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    const chips = (await screen.findAllByRole('button')).map((button) => button.textContent);
    expect(chips.slice(2)).toEqual(['Open Paths', 'Open Filters', 'Search by stable ID', 'Expand']);
    await userEvent.click(screen.getByRole('button', { name: 'Open Paths' }));
    expect(activated).toBe(1);
  });

  it('shows names that look like markup as text', async () => {
    const h = harness(async () => ({ ok: true, value: { refused: { cause: 'missing-inputs', sentence: ASK_REFUSAL_SENTENCES['missing-inputs'], missing: ['<b>x</b>'] } } }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    expect(await screen.findByText('<b>x</b>')).toBeTruthy();
  });
});

const TOKEN = `${'1'.repeat(10)}.${'a'.repeat(64)}`;
const HEAVY: AskAnswer = { answered: { intent: 'shared-devices', entities: { account: 'acc-1' }, outcome: 'complete', continueToken: TOKEN, result: { templateId: 'shared-attribute', result: heavyRun() } } };

describe('the Ask panel: heavy stops, failures and masking', () => {
  it('stops a heavy result and continues it with the kept entities and token', async () => {
    const h = harness(async () => ({ ok: true, value: HEAVY }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    expect(await screen.findByText(ASK_COPY.heavyBody)).toBeTruthy();
    expect(h.continued).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('heading', { name: 'Answer ready' })).toBeTruthy();
    expect(h.continued).toEqual([{ sourceId: 'a', intent: 'shared-devices', entities: { account: 'acc-1' }, continueToken: TOKEN }]);
  });

  it('says an invalid continue is no longer valid and asks the kept question again', async () => {
    const h = harness(async () => ({ ok: true, value: HEAVY }), async () => ({ ok: false, failure: failure('INVALID_REQUEST', { reason: 'continue-invalid' }) }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByText(ASK_COPY.continueInvalid)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Ask again' }));
    expect(h.sent.map((request) => request.question)).toEqual(['q', 'q']);
  });

  it('shows a failure in words with Try again for a retryable code and sends the same question again', async () => {
    let calls = 0;
    const h = harness(async () => (++calls === 1 ? { ok: false, failure: failure('AUDIT_UNAVAILABLE') } : { ok: true, value: ANSWER }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    expect(await screen.findByText(/answer is withheld/)).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', { name: 'Answer ready' })).toBeTruthy();
    expect(h.sent.map((request) => request.question)).toEqual(['q', 'q']);
  });

  it('shows the unavailable card for an edition without Ask', async () => {
    const h = harness(async () => ({ ok: false, failure: failure('ASK_UNSUPPORTED', { reason: 'not-in-this-edition' }) }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    expect(await screen.findByText(ASK_REFUSAL_SENTENCES.unavailable)).toBeTruthy();
  });

  it('clears an answer when masking changes and says so', async () => {
    const h = harness(async () => ({ ok: true, value: ANSWER }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    await screen.findByRole('heading', { name: 'Answer ready' });
    act(() => h.state.setMask(true));
    expect(await screen.findByText('Masking changed, so this answer is cleared. Ask again to see it.', { selector: 'p.ask-note' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Answer ready' })).toBeNull();
  });
});

describe('the Ask panel: closing, masking and the source', () => {
  it('shows nothing of an answer that comes after masking changed, and never sends the old token with the new masking', async () => {
    let finish: (value: ApiResult<AskAnswer>) => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (finish = resolve)));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    act(() => h.state.setMask(true));
    finish({ ok: true, value: ANSWER });
    expect(await screen.findByText('Masking changed, so this answer is cleared. Ask again to see it.', { selector: 'p.ask-note' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Answer ready' })).toBeNull();
  });

  it('aborts a question that is out when the panel closes, and shows no answer for it on reopening', async () => {
    let signal: AbortSignal | undefined;
    const h = harness(
      (_request, given) =>
        new Promise(() => {
          signal = given;
        }),
    );
    const view = render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    view.rerender(h.tree(false));
    expect(signal?.aborted).toBe(true);
    view.rerender(h.tree(true));
    expect(screen.getByRole('heading', { name: 'Cancelled' })).toBeTruthy();
  });

  it('closes on Escape and gives the focus back to the Ask control of the header', async () => {
    const h = harness(async () => ({ ok: true, value: ANSWER }));
    let closed = 0;
    const control = document.createElement('button');
    control.className = 'header-ai';
    control.textContent = 'Ask';
    document.body.append(control);
    const tree = (
      <ApiClientProvider client={fakeClient({})}>
        <ClientStateProvider state={h.state}>
          <ToolsProvider registry={h.tools}>
            <AskSessionProvider value={h.session}>
              <AskPanel onClose={() => (closed += 1)} />
            </AskSessionProvider>
          </ToolsProvider>
        </ClientStateProvider>
      </ApiClientProvider>
    );
    render(tree);
    await userEvent.type(screen.getByLabelText('Your question'), '{Escape}');
    expect(closed).toBe(1);
    expect(document.activeElement).toBe(control);
    control.remove();
  });

  it('sends one continue for a double press', async () => {
    let release: (value: ApiResult<AskAnswer>) => void = () => undefined;
    const h = harness(async () => ({ ok: true, value: HEAVY }), () => new Promise((resolve) => (release = resolve)));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    const button = await screen.findByRole('button', { name: 'Continue' });
    await userEvent.dblClick(button);
    expect(h.continued).toHaveLength(1);
    release({ ok: true, value: ANSWER });
  });

  it('shows the question as typed on the refusal card, as data', async () => {
    const h = harness(async () => ({ ok: true, value: { refused: { cause: 'no-intent', sentence: ASK_REFUSAL_SENTENCES['no-intent'] } } }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), '<i>hi</i>{Enter}');
    expect(await screen.findByText('<i>hi</i>', { selector: 'p.ask-typed-text' })).toBeTruthy();
  });

  it('says nothing is answered for a failure, so a screen reader hears it', async () => {
    const h = harness(async () => ({ ok: false, failure: failure('AUDIT_UNAVAILABLE') }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    await screen.findByText(/answer is withheld/);
    expect(screen.getByRole('heading', { name: 'Audit unavailable' })).toBeTruthy();
  });
});

describe('the Ask panel: guards', () => {
  const record = { title: 'T', caseRef: null, status: 'open' as const, readOnly: false, version: 1, save: { kind: 'unsaved' as const } };
  const load = (state: ReturnType<typeof harness>['state'], id: string, sourceState?: 'removed') => state.show({ id, sourceId: 'a', record: { ...record, ...(sourceState === undefined ? {} : { sourceState }) }, resultKeys: [], nodeRefs: [], edgeRefs: [] }, []);

  it('holds Try again back for the wait a rate limit asks for', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const h = harness(async () => ({ ok: false, failure: failure('RATE_LIMITED', { retryAfterMs: 4000 }) }));
      render(h.tree(true));
      await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
      const button = (await screen.findByRole('button', { name: 'Try again' })) as HTMLButtonElement;
      expect(button.disabled).toBe(true);
      await act(async () => {
        vi.advanceTimersByTime(4100);
      });
      expect(button.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('disables Send and says why while the source has changed', async () => {
    const h = harness(async () => ({ ok: true, value: ANSWER }));
    load(h.state, 'inv-1', 'removed');
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q');
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('The source changed, so questions are paused.')).toBeTruthy();
  });

  it('offers no working Add to graph without a known person', async () => {
    const h = harness(async () => ({ ok: true, value: ANSWER }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    const add = (await screen.findByRole('button', { name: /^Add / })) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });

  it('starts a new session for a new investigation: an answer in flight is aborted and the earlier question and answer are gone', async () => {
    let signal: AbortSignal | undefined;
    const h = harness(async (_request, given) => {
      signal = given;
      return new Promise(() => undefined);
    });
    load(h.state, 'inv-1');
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    act(() => {
      load(h.state, 'inv-2');
    });
    expect(signal?.aborted).toBe(true);
    expect((screen.getByLabelText('Your question') as HTMLTextAreaElement).value).toBe('');
    expect(screen.getByText(ASK_COPY.intro)).toBeTruthy();
  });
});

describe('the Ask panel: the lines of a refusal', () => {
  it('says nothing for a list that is empty instead of leaving the line blank, and draws what is missing as a problem', async () => {
    const h = harness(async () => ({ ok: true, value: { refused: { cause: 'missing-inputs', sentence: ASK_REFUSAL_SENTENCES['missing-inputs'], intent: 'find', parameters: ['accountId'], found: [], missing: ['accountId'] } } }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    await screen.findByRole('heading', { name: 'Ask did not answer' });
    const lines = [...document.querySelectorAll('.ask-line')].map((line) => line.textContent);
    expect(lines).toEqual(['NeedsAccount ID', 'Foundnothing', 'MissingAccount ID']);
    expect(document.querySelectorAll('.ask-problem')).toHaveLength(2);
  });
});

describe('the Ask panel: Escape and the limit', () => {
  it('cancels a question that is out on the first Escape and closes on the second', async () => {
    const h = harness(() => new Promise(() => undefined));
    let closed = 0;
    const tree = (
      <ApiClientProvider client={fakeClient({ ask: () => new Promise(() => undefined) })}>
        <ClientStateProvider state={h.state}>
          <ToolsProvider registry={h.tools}>
            <AskSessionProvider value={h.session}>
              <AskPanel onClose={() => (closed += 1)} />
            </AskSessionProvider>
          </ToolsProvider>
        </ClientStateProvider>
      </ApiClientProvider>
    );
    render(tree);
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    await userEvent.keyboard('{Escape}');
    expect(closed).toBe(0);
    expect(screen.getByRole('heading', { name: 'Cancelled' })).toBeTruthy();
    await userEvent.keyboard('{Escape}');
    expect(closed).toBe(1);
  });

  it('stops the text at the limit and says so, counting characters not units', async () => {
    const h = harness(async () => ({ ok: true, value: ANSWER }));
    render(h.tree(true));
    const field = screen.getByLabelText('Your question') as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: '😀'.repeat(1005) } });
    expect([...field.value]).toHaveLength(1000);
    expect(screen.getByText('1,000 / 1,000')).toBeTruthy();
    expect(screen.getByText(ASK_COPY.limitReached)).toBeTruthy();
    expect((screen.getByRole('button', { name: /^Send/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('counts what is typed and reads the count as "of"', async () => {
    const h = harness(async () => ({ ok: true, value: ANSWER }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'abc');
    expect(screen.getByText('3 / 1,000').getAttribute('aria-label')).toBe('3 of 1,000');
  });
});

describe('the Ask panel: Add to graph says what it adds', () => {
  it('writes the count only when the result lists that many, else the number it lists', async () => {
    const withCount = (value: number) => askAnswerSchema.parse({ answered: { intent: 'accounts-paid-by', entities: { id: 'acc-1' }, outcome: 'complete', result: { templateId: 'shared-attribute', result: okRun(['acc-2'], { count: { value, quality: 'exact', scope: 'matches' } }) } } });
    for (const [value, label] of [[1, 'Add 1 to graph'], [40, 'Add first 1 to graph']] as const) {
      const h = harness(async () => ({ ok: true, value: withCount(value) }));
      const view = render(h.tree(true));
      await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
      expect(await screen.findByRole('button', { name: label })).toBeTruthy();
      view.unmount();
    }
  });
});

describe('the Ask panel: the figure of a count', () => {
  it('writes the sign of the quality before the number and the plural of the noun', async () => {
    const { countFigure } = await import('./answer-card.js');
    expect(countFigure({ count: { quality: 'exact', value: 12, scope: 'matches' }, noun: 'match' })).toBe('12 matches');
    expect(countFigure({ count: { quality: 'exact', value: 1, scope: 'matches' }, noun: 'match' })).toBe('1 match');
    expect(countFigure({ count: { quality: 'estimated', value: 40000, scope: 'matches' }, noun: 'match' })).toBe('~ 40,000 matches');
    expect(countFigure({ count: { quality: 'lowerBound', value: 200, scope: 'rows' }, noun: 'row' })).toBe('≥ 200 rows');
    expect(countFigure({ count: { quality: 'unknown', scope: 'rows' }, noun: 'row' })).toBe('No count');
  });
});

describe('the Ask panel: the answer card', () => {
  const ENTITY = { ref: { sourceId: 'a', entityType: 'kind-a', stableId: 'acc-1' }, display: { title: 'acc-1', type: 'kind-a' }, properties: [], qualityFlags: [], provenanceRefs: [], authorization: { canInspect: true, canExport: true } };
  const summarized = (extra: Record<string, unknown> = {}): AskAnswer => askAnswerSchema.parse({ answered: { intent: 'accounts-paid-by', entities: { accountId: 'acc-1' }, outcome: 'complete', result: { templateId: 'entity', result: ENTITY }, summary: { sentences: [{ text: 'acc-1 is here.', cites: ['n1'] }], citations: [{ key: 'n1', element: ENTITY.ref, type: 'kind-a', title: 'acc-1' }], omissions: 'Not named in the answer: none.' }, ...extra } });

  it('says what the question was taken as and the values taken from it, in words', async () => {
    const h = harness(async () => ({ ok: true, value: summarized() }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    expect(await screen.findByText('Accounts paid by')).toBeTruthy();
    expect(screen.getByText('Account ID')).toBeTruthy();
    expect(document.querySelector('.ask-values-row dd')?.textContent).toBe('acc-1');
  });

  it('lists the sources, and a source that is not on the graph says to add it first, then can be selected once it is added', async () => {
    const h = harness(async () => ({ ok: true, value: summarized() }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    expect(await screen.findByText('Sources · 1')).toBeTruthy();
    expect(screen.getByText('Use Add to graph first', { selector: '.ask-source-blocked' })).toBeTruthy();
    expect(screen.getByText('Not named in the answer: none.')).toBeTruthy();
  });

  it('shows the name of the person’s own saved pattern, with the note that others never see it', async () => {
    const answer = askAnswerSchema.parse({ answered: { intent: 'saved-pattern', patternName: 'Frozen payments', entities: {}, outcome: 'complete', result: { templateId: 'entity', result: ENTITY } } });
    const h = harness(async () => ({ ok: true, value: answer }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    expect(await screen.findByText('Frozen payments')).toBeTruthy();
    expect(screen.getByText('Your saved pattern')).toBeTruthy();
    expect(screen.getByText(ASK_COPY.patternPrivate)).toBeTruthy();
  });

  it('shows the starting entity of a saved pattern as Start and never the id of the pattern', async () => {
    const answer = askAnswerSchema.parse({ answered: { intent: 'saved-pattern', patternName: 'Frozen payments', entities: { pattern: '0a1b2c3d-0000-4000-8000-000000000000', anchor: 'acc-1' }, outcome: 'complete', result: { templateId: 'entity', result: ENTITY } } });
    const h = harness(async () => ({ ok: true, value: answer }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    await screen.findByText('Frozen payments');
    expect([...document.querySelectorAll('.ask-values-row')].map((row) => row.textContent)).toEqual(['Startacc-1']);
  });

  it('draws the estimate of a heavy stop with its quality word and offers Continue without Cancel', async () => {
    const h = harness(async () => ({ ok: true, value: HEAVY }));
    render(h.tree(true));
    await userEvent.type(screen.getByLabelText('Your question'), 'q{Enter}');
    expect(await screen.findByText('≥ 500 matches')).toBeTruthy();
    expect(screen.getByText('Lower bound')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText(ASK_COPY.heavyNote)).toBeTruthy();
  });
});
