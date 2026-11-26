import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { offersRetry, FailureNotice } from '../failure-notice.js';
import { PageFrame } from '../shell/page-shell.js';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { useEffect, useState } from 'react';
import { useClientState, useLoadedGraph, useVisibleGraph } from '../state/context.js';
import { drawnKeys } from '../state/loaded-graph.js';
import { GraphWindowLink } from '../windows/graph-window-link.js';
import { ASSISTANT_COPY } from '../assistant/copy.js';
import { maskSwitchOf } from '../mask/mask-switch.js';
import { WorkspaceShell } from '../workspace/workspace-shell.js';
import { AttemptedSource } from './attempted-source.js';
import { useStoreSelector } from '../state/store.js';
import { BACK_TO_HOME, NOT_FOUND_TEXT, NOT_FOUND_TITLE, OPENING, openingOver, RESUMED, TRY_AGAIN } from './messages.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { useOpenInvestigation } from './use-open-investigation.js';
import { SOME_ITEMS_UNAVAILABLE } from '../draft/copy.js';
import { restoreNoticeOf } from '../views/restore-notice.js';
import { DraftAnnouncer, DraftConflictBanner, DraftStatusLine } from '../draft/draft-status.js';
import { MappingChangeBanner } from '../draft/mapping-banner.js';
import { draftSyncOf } from '../draft/draft-sync.js';
import { ReadOnlyBannerSync } from '../lifecycle/read-only-banner.js';
import { restoreIntentOf } from '../investigations-page/restore-intent.js';
import { viewNotLoaded } from '../investigations-page/copy.js';
import { RestoreConfirm } from '../views/restore-confirm.js';

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

/** The key of the element another window asked to have selected on arrival: carried in the navigation state, never in the address. */
function selectKeyOf(state: unknown): string | undefined {
  return typeof state === 'object' && state !== null && 'select' in state && typeof state.select === 'string' && state.select !== '' ? state.select : undefined;
}

function arrivedByResuming(state: unknown): boolean {
  return typeof state === 'object' && state !== null && 'resumed' in state && state.resumed === true;
}

/** `/explore/{id}`: shows the investigation. The one that was on screen stays, identified as its own, until the new one is read; a failure leaves it there. */
export function ExploreInvestigation({ client }: { readonly client: ApiClient }) {
  const { investigationId } = useParams();
  const state = useClientState();
  const shell = useShellData();
  const principalId = answeredData(shell.me)?.principal.id;
  const principalFailure = principalId === undefined ? retainedFailure(shell.me) : undefined;
  const navigate = useNavigate();
  const location = useLocation();
  const resumed = arrivedByResuming(location.state);
  const restoreAsked = restoreIntentOf(location.state);
  const arrivalKey = selectKeyOf(location.state);
  const arrivalGraph = useVisibleGraph();
  const loadedGraph = useLoadedGraph();
  const [arrivalMissing, setArrivalMissing] = useState<{ readonly investigationId: string; readonly key: string } | undefined>(undefined);
  const { status, again } = useOpenInvestigation(client, investigationId, principalId);
  const onScreen = useStoreSelector(state.investigation, (held) => held);
  const graphReady = loadedGraph.nodes.length > 0 || onScreen.nodeRefs.length === 0;
  useEffect(() => {
    if (arrivalKey === undefined || status.kind !== 'ready' || onScreen.id !== investigationId || investigationId === undefined || !graphReady) return;
    if (drawnKeys(arrivalGraph).has(arrivalKey)) state.presentation.select([arrivalKey]);
    else setArrivalMissing({ investigationId, key: arrivalKey });
    const rest = Object.fromEntries(Object.entries(location.state as Record<string, unknown>).filter(([name]) => name !== 'select'));
    void navigate(location.pathname, { replace: true, state: Object.keys(rest).length === 0 ? undefined : rest });
  }, [arrivalKey, arrivalGraph, graphReady, status.kind, onScreen.id, investigationId]);
  const sync = draftSyncOf(state, client);
  const maskRead = useStoreSelector(maskSwitchOf(state, client).status, (current) => current);
  const draftKind = useStoreSelector(sync.status, (current) => current.kind);
  const restoredMissing = useStoreSelector(restoreNoticeOf(state).missing, (missing) => missing);
  const previousTitle = onScreen.id !== null && onScreen.id !== investigationId ? (onScreen.record?.title ?? null) : null;
  const missingShown = arrivalMissing !== undefined && arrivalMissing.investigationId === investigationId && !drawnKeys(arrivalGraph).has(arrivalMissing.key);
  if (status.kind === 'not-found') return <Message title={NOT_FOUND_TITLE} text={NOT_FOUND_TEXT} source={null} attempted={status.sourceId} />;
  const failure = status.kind === 'failed' ? status.failure : status.kind === 'loading' ? principalFailure : undefined;
  const retry = (): void => {
    if (principalId === undefined) shell.reload();
    again();
  };
  const statusLine = status.kind === 'loading' && failure === undefined ? <p role="status">{previousTitle === null ? OPENING : openingOver(previousTitle)}</p> : status.kind === 'ready' && resumed ? <p role="status">{RESUMED}</p> : status.kind === 'ready' && (status.someMissing === true || restoredMissing) ? <p role="status">{SOME_ITEMS_UNAVAILABLE}</p> : undefined;
  const record = onScreen.id === investigationId ? onScreen.record : null;
  const restoreReady = status.kind === 'ready' && restoreAsked !== undefined && record !== null;
  const notLoaded = restoreReady && record.readOnly && record.status !== 'open' ? viewNotLoaded(record.status) : undefined;
  const asking = restoreReady && !record.readOnly ? restoreAsked : undefined;
  const visible = draftKind === 'idle' || draftKind === 'conflict' ? statusLine : <>{statusLine}<DraftStatusLine sync={sync} /></>;
  return (
    <>
    <WorkspaceShell
      notice={
        failure !== undefined ? (
          <div role="group" aria-label="Opening failed">
            <FailureNotice failure={failure} />
            {status.kind === 'failed' && status.sourceId !== undefined ? <AttemptedSource sourceId={status.sourceId} /> : null}
            {offersRetry(failure) ? (
              <button type="button" className="secondary" onClick={retry}>
                {TRY_AGAIN}
              </button>
            ) : null}
          </div>
        ) : maskRead.kind === 'failed' ? (
          <div role="group" aria-label="Masking change failed">
            <FailureNotice failure={maskRead.failure} />
            <button type="button" className="secondary" onClick={maskSwitchOf(state, client).retry}>
              {TRY_AGAIN}
            </button>
          </div>
        ) : undefined
      }
      busy={status.kind === 'loading' && failure === undefined}
      status={missingShown ? <>{notLoaded === undefined ? visible : <>{visible}<p role="status">{notLoaded}</p></>}<p role="status">{ASSISTANT_COPY.selectionNotOnCanvas}</p></> : notLoaded === undefined ? visible : <>{visible}<p role="status">{notLoaded}</p></>}
    />
    {asking === undefined ? null : <RestoreConfirm view={asking} onClose={() => void navigate(location.pathname, { replace: true, state: undefined })} />}
    <GraphWindowLink />
    <DraftAnnouncer sync={sync} />
    <DraftConflictBanner sync={sync} />
    {/* the order matters: both use the one standing-banner slot, and the read-only sync clears it before the mapping banner sets it again on a reopen */}
    <ReadOnlyBannerSync client={client} />
    <MappingChangeBanner />
    </>
  );
}
