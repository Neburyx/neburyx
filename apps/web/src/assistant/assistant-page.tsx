import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import type { ApiClient } from '../api/client.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { AttemptedSource } from '../investigations/attempted-source.js';
import { BACK_TO_HOME, NOT_FOUND_TEXT, NOT_FOUND_TITLE, TRY_AGAIN } from '../investigations/messages.js';
import { useOpenInvestigation } from '../investigations/use-open-investigation.js';
import { PageFrame } from '../shell/page-shell.js';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { ASSISTANT_PATH, EXPLORE_PATH, INVESTIGATIONS_PATH } from '../shell/navigation.js';
import { useClientState } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { AssistantSurface } from './assistant-panel.js';
import { ChatListColumn } from './chat-list/chat-list-column.js';
import { NewChatPicker } from './new-chat/new-chat-picker.js';
import { assistantSessionOf, AssistantSessionProvider } from './assistant-session.js';
import { ASSISTANT_COPY } from './copy.js';
import { useAssistantPageWindow } from '../windows/assistant-window.js';
import { SourceSelectionProvider } from './source-selection-context.js';

function Message({ title, text, children }: { readonly title: string; readonly text?: string; readonly children?: React.ReactNode }) {
  return (
    <PageFrame>
      <section>
        <PageHeading title={title} description={text} source={null} />
        {children}
        <p>
          <Link to="/">{BACK_TO_HOME}</Link>
        </p>
      </section>
    </PageFrame>
  );
}

/** `/assistant`: with an investigation held in this window the page of that investigation; with none, the way to open one. */
export function AssistantEntry() {
  const state = useClientState();
  const held = useStoreSelector(state.investigation, (investigation) => investigation.id);
  if (held !== null) return <Navigate to={`${ASSISTANT_PATH}/${encodeURIComponent(held)}`} replace />;
  return (
    <PageFrame>
      <section>
        <PageHeading title={ASSISTANT_COPY.pageNeedsInvestigationTitle} description={ASSISTANT_COPY.pageNeedsInvestigation} source={null} />
        <p>
          <Link to={INVESTIGATIONS_PATH}>{ASSISTANT_COPY.toInvestigations}</Link>
        </p>
      </section>
    </PageFrame>
  );
}

/** `/assistant/{investigationId}`: the Assistant on a full page, over the one thread the panel shows. */
export function AssistantPage({ client }: { readonly client: ApiClient }) {
  const { investigationId } = useParams();
  const navigate = useNavigate();
  const state = useClientState();
  const shell = useShellData();
  const principalId = answeredData(shell.me)?.principal.id;
  const principalFailure = principalId === undefined ? retainedFailure(shell.me) : undefined;
  const { status, again } = useOpenInvestigation(client, investigationId, principalId, (shownId) => (shownId === null ? '/' : `${ASSISTANT_PATH}/${encodeURIComponent(shownId)}`));
  const shownId = useStoreSelector(state.investigation, (investigation) => investigation.id);
  const session = assistantSessionOf(state);
  const newChat = useRef<HTMLButtonElement | null>(null);
  const [picking, setPicking] = useState(false);
  // the picker belongs to the investigation the page is on: another one closes it
  useEffect(() => setPicking(false), [investigationId]);
  // the button is the column's: the picker says on it whether it is open (the frame draws the open state), without a change of the column. It is drawn only once the page is ready, and again with each investigation, so this runs after every render.
  useLayoutEffect(() => {
    const button = newChat.current;
    if (button === null) return undefined;
    button.setAttribute('aria-haspopup', 'dialog');
    button.setAttribute('aria-expanded', picking ? 'true' : 'false');
    return () => {
      button.removeAttribute('aria-expanded');
      button.removeAttribute('aria-haspopup');
    };
  });
  useAssistantPageWindow();
  if (status.kind === 'not-found') return <Message title={NOT_FOUND_TITLE} text={NOT_FOUND_TEXT}>{status.sourceId === undefined ? null : <AttemptedSource sourceId={status.sourceId} />}</Message>;
  const failure = status.kind === 'failed' ? status.failure : status.kind === 'loading' ? principalFailure : undefined;
  if (failure !== undefined) {
    const retry = (): void => {
      if (principalId === undefined) shell.reload();
      again();
    };
    return (
      <Message title={ASSISTANT_COPY.title}>
        <div role="group" aria-label="Opening failed">
          <FailureNotice failure={failure} />
          {status.kind === 'failed' && status.sourceId !== undefined ? <AttemptedSource sourceId={status.sourceId} /> : null}
          {canRetry(failure) ? (
            <button type="button" className="secondary" onClick={retry}>
              {TRY_AGAIN}
            </button>
          ) : null}
        </div>
      </Message>
    );
  }
  if (status.kind === 'loading' || shownId !== investigationId || session === undefined) {
    return (
      <PageFrame>
        <p role="status">{ASSISTANT_COPY.pageOpening}</p>
      </PageFrame>
    );
  }
  return (
    <PageFrame bare>
      <div className="assistant-page">
        <AssistantSessionProvider value={session}>
          <ChatListColumn onNewChat={() => setPicking((held) => !held)} newChatRef={newChat} />
          {picking ? <NewChatPicker anchor={newChat} onClose={() => setPicking(false)} /> : null}
          <div className="assistant-page-thread">
            <SourceSelectionProvider openGraph={(key) => void navigate(`${EXPLORE_PATH}/${encodeURIComponent(shownId)}`, { state: { select: key } })}>
              <AssistantSurface variant="page" />
            </SourceSelectionProvider>
          </div>
        </AssistantSessionProvider>
      </div>
    </PageFrame>
  );
}
