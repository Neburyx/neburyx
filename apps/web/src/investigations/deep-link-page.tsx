import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { canRetry, FailureNotice } from '../failure-notice.js';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, retainedFailure, useShellData } from '../shell/shell-data.js';
import { useSourceName } from '../shell/use-current-source.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { AttemptedSource } from './attempted-source.js';
import { deepLinkPath, readDeepLink } from './deep-link.js';
import { BACK_TO_HOME, LINK_FAILED_TITLE, LINK_MALFORMED_TEXT, LINK_MALFORMED_TITLE, LINK_NOT_FOUND_TEXT, LINK_NOT_FOUND_TITLE, LINK_UNKNOWN_TYPE_TITLE, linkUnknownTypeText, OPENING_LINK, OPENING_LINK_TEXT, OPENING_LINK_TITLE, SOURCE_NOT_AVAILABLE_TEXT, SOURCE_NOT_AVAILABLE_TITLE, TRY_AGAIN } from './messages.js';
import { openEntity, type OpenEntityOutcome } from './open-flow.js';

interface Flight {
  readonly key: string;
  readonly controller: AbortController;
  readonly outcome: Promise<OpenEntityOutcome>;
}

type Status =
  | { readonly kind: 'opening' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unknown-type'; readonly sourceId: string }
  | { readonly kind: 'source-unavailable'; readonly sourceId: string }
  | { readonly kind: 'failed'; readonly failure: ApiFailure; readonly sourceId?: string };

const OPENING: Status = { kind: 'opening' };

function Message({ title, text, source }: { readonly title: string; readonly text: string; readonly source: string | null }) {
  return (
    <section>
      <PageHeading title={title} description={text} source={source} focused />
      <p>
        <Link to="/">{BACK_TO_HOME}</Link>
      </p>
    </section>
  );
}

function UnknownType({ sourceId }: { readonly sourceId: string }) {
  return <Message title={LINK_UNKNOWN_TYPE_TITLE} text={linkUnknownTypeText(useSourceName(sourceId))} source={null} />;
}

/** The page of a deep link: opens the entity it names as an investigation and replaces its own address with the investigation's. */
export function DeepLinkPage({ client }: { readonly client: ApiClient }) {
  const location = useLocation();
  const navigate = useNavigate();
  const state = useClientState();
  const mask = useSessionMask();
  const shell = useShellData();
  const principalId = answeredData(shell.me)?.principal.id;
  const principalFailure = principalId === undefined ? retainedFailure(shell.me) : undefined;
  const read = readDeepLink(`${location.pathname}${location.search}`, window.location.origin);
  const key = read.ok ? deepLinkPath(read.link) : undefined;
  const [attempt, setAttempt] = useState(0);
  const [tracked, setTracked] = useState<{ readonly key: string | undefined; readonly status: Status }>({ key, status: OPENING });
  const status = tracked.key === key ? tracked.status : OPENING;
  const flight = useRef<Flight | undefined>(undefined);
  const runs = useRef(0);

  useEffect(() => {
    if (!read.ok || key === undefined || principalId === undefined) return undefined;
    const { link } = read;
    const run = (runs.current += 1);
    let current = true;
    const setStatus = (next: Status): void => setTracked({ key, status: next });
    if (flight.current?.key !== key || flight.current.controller.signal.aborted) {
      flight.current?.controller.abort();
      const controller = new AbortController();
      const request = { sourceId: link.sourceId, entity: { sourceId: link.sourceId, entityType: link.entityType, stableId: link.stableId }, ...(link.caseRef === undefined ? {} : { caseRef: link.caseRef }) };
      flight.current = { key, controller, outcome: openEntity(client, state, request, { principalId, mask }, controller.signal) };
    }
    const { controller, outcome } = flight.current;
    setStatus(OPENING);
    void outcome.then((answer) => {
      if (!current || controller.signal.aborted) return;
      if (answer.kind === 'shown') navigate(`${EXPLORE_PATH}/${answer.id}`, { replace: true, state: { resumed: answer.created === false } });
      else if (answer.kind === 'source-unavailable') setStatus({ kind: 'source-unavailable', sourceId: answer.investigation.sourceId });
      else if (answer.failure.code === 'NOT_FOUND') setStatus({ kind: 'not-found' });
      else if (answer.failure.code === 'INVALID_REQUEST') setStatus({ kind: 'unknown-type', sourceId: link.sourceId });
      else setStatus({ kind: 'failed', failure: answer.failure, ...(answer.sourceId === undefined ? {} : { sourceId: answer.sourceId }) });
    });
    // the replayed effect of StrictMode runs this cleanup and then the effect again: only a cleanup that no effect run follows ends the open
    return () => {
      current = false;
      void Promise.resolve().then(() => {
        if (runs.current === run) controller.abort();
      });
    };
  }, [client, state, key, principalId, mask, attempt]);

  const retry = (): void => {
    flight.current = undefined;
    if (principalId === undefined) shell.reload();
    setAttempt((count) => count + 1);
  };

  if (!read.ok) return <Message title={LINK_MALFORMED_TITLE} text={LINK_MALFORMED_TEXT} source={null} />;
  if (status.kind === 'not-found') return <Message title={LINK_NOT_FOUND_TITLE} text={LINK_NOT_FOUND_TEXT} source={null} />;
  if (status.kind === 'unknown-type') return <UnknownType sourceId={status.sourceId} />;
  if (status.kind === 'source-unavailable') return <Message title={SOURCE_NOT_AVAILABLE_TITLE} text={SOURCE_NOT_AVAILABLE_TEXT} source={status.sourceId} />;
  const failure = status.kind === 'failed' ? status.failure : principalFailure;
  return (
    <section>
      <PageHeading title={failure === undefined ? OPENING_LINK_TITLE : LINK_FAILED_TITLE} description={OPENING_LINK_TEXT} focused={failure !== undefined} />
      {failure === undefined ? (
        <p role="status">{OPENING_LINK}</p>
      ) : (
        <div role="group" aria-label="Opening failed">
          <FailureNotice failure={failure} />
          {status.kind === 'failed' && status.sourceId !== undefined ? <AttemptedSource sourceId={status.sourceId} /> : null}
          {canRetry(failure) ? (
            <button type="button" className="secondary" onClick={retry}>
              {TRY_AGAIN}
            </button>
          ) : null}
          <p>
            <Link to="/">{BACK_TO_HOME}</Link>
          </p>
        </div>
      )}
    </section>
  );
}
