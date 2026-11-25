import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { ASSISTANT_NOT_ANSWERED_SENTENCE, ASSISTANT_REFUSAL_SENTENCES, type AssistantTurnAnswer } from '@neburyx/contracts';
import { fakeClient } from '../api/fake-client.js';
import type { ApiResult } from '../api/client.js';
import { ApiClientProvider } from '../api/client-context.js';
import { ShellDataProvider } from '../shell/shell-data.js';
import { ClientStateProvider } from '../state/context.js';
import { key, node } from '../state/test-data.js';
import { createToolRegistry, ToolsProvider } from '../workspace/tool-registry.js';
import { AssistantPanel } from './assistant-panel.js';
import { AssistantSessionProvider } from './assistant-session.js';
import { harness, messageOf, RECORD, REFUSE, typeAndSend, VIEW } from './assistant-kit.js';
import { ASSISTANT_COPY, hintText } from './copy.js';

afterEach(cleanup);

describe('the Assistant panel: the intro and the read of the earlier chat', () => {
  it('shows the intro only after the read of the earlier chat is answered with nothing, not beside the line that says it is reading', async () => {
    let answer: (value: ApiResult<{ turns: never[]; earlierTurns: number; previousThreadClearedAt: null }>) => void = () => undefined;
    const h = harness(async () => ({ ok: true, value: REFUSE }), 800, () => new Promise((resolve) => (answer = resolve)));
    render(h.tree());
    expect(await screen.findByText(ASSISTANT_COPY.storedLoading)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.introTitle)).toBeNull();
    await act(async () => answer({ ok: true, value: { turns: [], earlierTurns: 0, previousThreadClearedAt: null } }));
    expect(await screen.findByText(ASSISTANT_COPY.introTitle)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.storedLoading)).toBeNull();
  });

  it('shows the intro when no read of the earlier chat will start because the source has changed', async () => {
    const h = harness(async () => ({ ok: true, value: REFUSE }), 800, () => new Promise(() => undefined));
    h.state.describeInvestigation({ ...RECORD, sourceState: 'removed' });
    render(h.tree());
    expect(await screen.findByText(ASSISTANT_COPY.introTitle)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_COPY.sourceChanged)).toBeTruthy();
    expect(screen.queryByText(ASSISTANT_COPY.storedLoading)).toBeNull();
  });
});

describe('the Assistant panel: a message', () => {
  it('shows the counter with the limit of the status and the hint, and sends nothing for a blank message', async () => {
    const h = harness(async () => ({ ok: true, value: REFUSE }), 800);
    render(h.tree());
    expect(await screen.findByText('0 / 800 words')).toBeTruthy();
    expect(screen.getByText(hintText(800))).toBeTruthy();
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), '   ');
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it('counts words as the server does and refuses to send over the limit, with the exact count and nothing sent', async () => {
    const h = harness(async () => ({ ok: true, value: REFUSE }), 3);
    render(h.tree());
    const field = await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    await userEvent.type(field, 'a\tb\n\nc  d');
    expect(screen.getByText('4 / 3 words')).toBeTruthy();
    expect(screen.getByText('Your message is 4 words. The limit is 3. Shorten it and send again.')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(h.sent).toEqual([]);
    expect((field as HTMLTextAreaElement).value).toBe('a\tb\n\nc  d');
  });

  it('sends the message as typed with the source, the investigation and the masking on Enter, and keeps Shift+Enter for a new line', async () => {
    const h = harness(async () => ({ ok: true, value: REFUSE }));
    h.state.setMask(true);
    render(h.tree());
    const field = await screen.findByLabelText(ASSISTANT_COPY.fieldLabel);
    await userEvent.type(field, 'who shares{Shift>}{Enter}{/Shift}a device?{Enter}');
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]).toMatchObject({ sourceId: 'a', message: 'who shares\na device?', mask: true, viewElementKeys: [] });
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
  });

  it('shows the waiting state while a turn is out, disables the input and sends one turn at a time', async () => {
    let finish: (value: ApiResult<AssistantTurnAnswer>) => void = () => undefined;
    const h = harness(() => new Promise((resolve) => (finish = resolve)));
    render(h.tree());
    await typeAndSend('first');
    expect(screen.getByRole('status').textContent).toBe(ASSISTANT_COPY.working);
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.getByPlaceholderText(ASSISTANT_COPY.waitingPlaceholder)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(ASSISTANT_COPY.fieldLabel), 'second{Enter}');
    expect(h.sent).toHaveLength(1);
    await act(async () => finish({ ok: true, value: VIEW }));
    expect(await screen.findByText(ASSISTANT_NOT_ANSWERED_SENTENCE)).toBeTruthy();
  });

  it('shows a refusal turn with its fixed sentence and a view turn with its tag and the fixed not-answered sentence, each titled Not answered', async () => {
    const answers = [REFUSE, VIEW];
    const h = harness(async () => ({ ok: true, value: answers.shift() ?? VIEW }));
    render(h.tree());
    await typeAndSend('is this guilty?');
    expect(await screen.findByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    expect(screen.getByText(ASSISTANT_REFUSAL_SENTENCES.verdict)).toBeTruthy();
    await typeAndSend('what is this?');
    expect(await screen.findByText(ASSISTANT_COPY.routeView, { selector: 'p' })).toBeTruthy();
    expect(screen.getAllByRole('heading', { name: ASSISTANT_COPY.notAnswered })).toHaveLength(2);
    expect(screen.getByText(ASSISTANT_NOT_ANSWERED_SENTENCE)).toBeTruthy();
    expect(screen.getAllByText(/is this guilty\?|what is this\?/)).toHaveLength(2);
  });

  it('moves the focus to the new turn when it arrives', async () => {
    const h = harness(async () => ({ ok: true, value: VIEW }));
    render(h.tree());
    await typeAndSend('what?');
    const heading = await screen.findByRole('heading', { name: ASSISTANT_COPY.notAnswered });
    expect(document.activeElement).toBe(heading);
  });
});

describe('the Assistant panel: when the assistant is not available', () => {
  it('says why, disables the input and the send button, and requests nothing from /v1/assistant', async () => {
    const h = harness(async () => ({ ok: true, value: REFUSE }), null);
    render(h.tree());
    expect(await screen.findByText(ASSISTANT_COPY.unavailableBody)).toBeTruthy();
    expect((screen.getByLabelText(ASSISTANT_COPY.fieldLabel) as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: /Send/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(ASSISTANT_COPY.unavailableSend)).toBeTruthy();
    expect(h.sent).toEqual([]);
  });
});

describe('the Assistant panel: the keyboard', () => {
  it('reaches every control by role and name, and Escape closes the panel', async () => {
    let closed = 0;
    const h = harness(async () => ({ ok: true, value: VIEW }));
    const view = render(
      <ApiClientProvider client={fakeClient({})}>
        <ClientStateProvider state={h.state}>
          <ShellDataProvider store={h.shell}>
            <ToolsProvider registry={createToolRegistry()}>
              <AssistantSessionProvider value={h.session}>
                <AssistantPanel onClose={() => closed++} />
              </AssistantSessionProvider>
            </ToolsProvider>
          </ShellDataProvider>
        </ClientStateProvider>
      </ApiClientProvider>,
    );
    expect(await screen.findByRole('button', { name: 'Close' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Send/ })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: ASSISTANT_COPY.fieldLabel })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('textbox', { name: ASSISTANT_COPY.fieldLabel }), { key: 'Escape' });
    expect(closed).toBe(1);
    view.unmount();
  });
});


describe('the Assistant panel: the examples of the empty thread', () => {
  it('shows the two fixed examples and the neutral note when the profile is not known', async () => {
    const h = harness(async () => ({ ok: true, value: REFUSE }));
    render(h.tree());
    expect(await screen.findByText('“Summarize what is on screen”')).toBeTruthy();
    expect(screen.getByText('“Is anything useful in the data?”')).toBeTruthy();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('It gives no verdict on guilt or intent. It never writes queries.')).toBeTruthy();
  });


});
