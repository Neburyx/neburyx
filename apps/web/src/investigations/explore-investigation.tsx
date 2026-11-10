import { useLayoutEffect, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { PageFrame } from '../shell/page-shell.js';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { WorkspaceShell } from '../workspace/workspace-shell.js';
import { AttemptedSource } from './attempted-source.js';
import { useStoreSelector } from '../state/store.js';
import { BACK_TO_HOME, NOT_FOUND_TEXT, NOT_FOUND_TITLE, OPENING, openingOver, RESUMED, SOURCE_NOT_AVAILABLE_TEXT, SOURCE_NOT_AVAILABLE_TITLE, TRY_AGAIN } from './messages.js';
import { openById } from './open-flow.js';
import { SOME_ITEMS_UNAVAILABLE } from '../draft/copy.js';
import { DraftAnnouncer, DraftConflictBanner, DraftStatusLine } from '../draft/draft-status.js';
import { draftSyncOf } from '../draft/draft-sync.js';

type Status =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly someMissing?: true }
  | { readonly kind: 'not-found'; readonly sourceId?: string }
  | { readonly kind: 'source-unavailable'; readonly sourceId: string }
  | { readonly kind: 'failed'; readonly failure: ApiFailure; readonly sourceId?: string };

function Message({ title, text, source, attempted }: { readonly title: string; readonly text: string; readonly source: string | null; readonly attempted?: string | undefined }) {
  return (
    <PageFrame>
      <section>
        <PageHeading title={title} description={text} source={source} />
        {attempted === undefined ? null : <AttemptedSource sourceId={attempted} />}
        <p>
          <Link to="/">{BACK_TO_HOME}</Link>
        </p>
      </section>
    </PageFrame>
  );
}

function arrivedByResuming(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'resumed' in state && state.resumed === true;
}

/** `/explore/{id}`: shows the investigation. The one that was on screen stays, identified as its own, until the new one is read; a failure leaves it there. */
export function ExploreInvestigation({ client }: { readonly client: ApiClient }) {
  const { investigationId } = useParams();
  const state = useClientState();
  const mask = useSessionMask();
  const shell = useShellData();
  const principalId = answeredData(shell.me)?.principal.id;
  const principalFailure = principalId === undefined ? retainedFailure(shell.me) : undefined;
  const resumed = arrivedByResuming(useLocation().state);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<Status>(() => (investigationId !== undefined && state.holds(investigationId, mask) ? { kind: 'ready' } : { kind: 'loading' }));
  const onScreen = useStoreSelector(state.investigation, (held) => held);
  const sync = draftSyncOf(state, client);
  const draftKind = useStoreSelector(sync.status, (current) => current.kind);
  const previousTitle = onScreen.id !== null && onScreen.id !== investigationId ? (onScreen.record?.title ?? null) : null;

  // A layout effect, so that a new address never paints the previous investigation before this page has marked it as loading.
  useLayoutEffect(() => {
    if (investigationId === undefined || principalId === undefined) return undefined;
    if (state.resume(investigationId, mask) !== undefined) {
      setStatus({ kind: 'ready' });
      return undefined;
    }
    const controller = new AbortController();
    setStatus({ kind: 'loading' });
    void openById(client, state, investigationId, { principalId, mask }, controller.signal).then((outcome) => {
      if (controller.signal.aborted) return;
      if (outcome.kind === 'shown') setStatus(outcome.someMissing === true ? { kind: 'ready', someMissing: true } : { kind: 'ready' });
      else if (outcome.kind === 'source-unavailable') setStatus({ kind: 'source-unavailable', sourceId: outcome.investigation.sourceId });
      else {
        const tried = outcome.sourceId === undefined ? {} : { sourceId: outcome.sourceId };
        setStatus(outcome.failure.code === 'NOT_FOUND' ? { kind: 'not-found', ...tried } : { kind: 'failed', failure: outcome.failure, ...tried });
      }
    });
    return () => controller.abort();
  }, [client, state, investigationId, principalId, mask, attempt]);

  if (status.kind === 'not-found') return <Message title={NOT_FOUND_TITLE} text={NOT_FOUND_TEXT} source={null} attempted={status.sourceId} />;
  if (status.kind === 'source-unavailable') return <Message title={SOURCE_NOT_AVAILABLE_TITLE} text={SOURCE_NOT_AVAILABLE_TEXT} source={status.sourceId} />;
  const failure = status.kind === 'failed' ? status.failure : status.kind === 'loading' ? principalFailure : undefined;
  const retry = (): void => {
    if (principalId === undefined) shell.reload();
    setAttempt((count) => count + 1);
  };
  const statusLine = status.kind === 'loading' && failure === undefined ? <p role="status">{previousTitle === null ? OPENING : openingOver(previousTitle)}</p> : status.kind === 'ready' && resumed ? <p role="status">{RESUMED}</p> : status.kind === 'ready' && status.someMissing === true ? <p role="status">{SOME_ITEMS_UNAVAILABLE}</p> : undefined;
  const visible = draftKind === 'idle' || draftKind === 'conflict' ? statusLine : <>{statusLine}<DraftStatusLine sync={sync} /></>;
  return (
    <>
    <WorkspaceShell
      notice={
        failure !== undefined ? (
          <div role="group" aria-label="Opening failed">
            <FailureNotice failure={failure} />
            {status.kind === 'failed' && status.sourceId !== undefined ? <AttemptedSource sourceId={status.sourceId} /> : null}
            {canRetry(failure) ? (
              <button type="button" className="secondary" onClick={retry}>
                {TRY_AGAIN}
              </button>
            ) : null}
          </div>
        ) : undefined
      }
      busy={status.kind === 'loading' && failure === undefined}
      status={visible}
    />
    <DraftAnnouncer sync={sync} />
    <DraftConflictBanner sync={sync} />
    </>
  );
}
