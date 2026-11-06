import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { SourceProfile } from '@neburyx/contracts';
import type { ApiClient, ApiFailure } from '../api/client.js';
import { FailureNotice } from '../failure-notice.js';
import { openEntity } from '../investigations/open-flow.js';
import { AttemptedSource } from '../investigations/attempted-source.js';
import { SOURCE_NOT_AVAILABLE_TEXT } from '../investigations/messages.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { PageHeading } from '../shell/page-heading.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { SourcesPanel } from './sources-panel.js';

type Refusal = { readonly kind: 'failure'; readonly failure: ApiFailure } | { readonly kind: 'source-unavailable' };

function OpenEntityForm({ client, profile }: { readonly client: ApiClient; readonly profile: SourceProfile }) {
  const state = useClientState();
  const mask = useSessionMask();
  const navigate = useNavigate();
  const principalId = answeredData(useShellData().me)?.principal.id;
  const [entityType, setEntityType] = useState(profile.entityTypes[0]?.type ?? '');
  const [stableId, setStableId] = useState('');
  const [caseRef, setCaseRef] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [refusal, setRefusal] = useState<Refusal | undefined>(undefined);
  const inFlight = useRef(false);
  const attempt = useRef<AbortController | undefined>(undefined);
  const message = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (refusal !== undefined) message.current?.focus();
  }, [refusal]);

  useEffect(() => () => attempt.current?.abort(), [profile.sourceId]);

  if (profile.entityTypes.length === 0) return <p role="status">This source has no entity types.</p>;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (inFlight.current || principalId === undefined || stableId === '') return;
    inFlight.current = true;
    setSubmitting(true);
    setRefusal(undefined);
    const controller = new AbortController();
    attempt.current = controller;
    const request = { sourceId: profile.sourceId, entity: { sourceId: profile.sourceId, entityType, stableId }, ...(caseRef === '' ? {} : { caseRef }) };
    void openEntity(client, state, request, { principalId, mask }, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) return;
        if (outcome.kind === 'shown') navigate(`${EXPLORE_PATH}/${outcome.id}`, { state: { resumed: outcome.created === false } });
        else setRefusal(outcome.kind === 'failed' ? { kind: 'failure', failure: outcome.failure } : { kind: 'source-unavailable' });
      })
      .finally(() => {
        inFlight.current = false;
        setSubmitting(false);
      });
  };

  return (
    <form onSubmit={submit} aria-label="Open an entity">
      <label>
        Entity type
        <select value={entityType} onChange={(event) => setEntityType(event.target.value)}>
          {profile.entityTypes.map((type) => (
            <option key={type.type} value={type.type}>
              {type.displayName}
            </option>
          ))}
        </select>
      </label>
      <label>
        Stable ID
        <input value={stableId} onChange={(event) => setStableId(event.target.value)} required />
      </label>
      <label>
        Case reference (optional)
        <input value={caseRef} onChange={(event) => setCaseRef(event.target.value)} />
      </label>
      <button type="submit" disabled={submitting || principalId === undefined}>
        Open
      </button>
      {refusal === undefined ? null : (
        <div role="group" aria-label="Opening failed" tabIndex={-1} ref={message}>
          {refusal.kind === 'failure' ? <FailureNotice failure={refusal.failure} /> : <p role="alert">{SOURCE_NOT_AVAILABLE_TEXT}</p>}
          <AttemptedSource sourceId={profile.sourceId} />
        </div>
      )}
    </form>
  );
}

export function OpenEntityPage({ client }: { readonly client: ApiClient }) {
  return (
    <section data-dev-tool="neburyx-dev-open-entity-route">
      <PageHeading title="Open an entity" description="Development only: opens an entity of a source as an investigation, as search and links will." />
      <SourcesPanel client={client} actions={(profile) => <OpenEntityForm client={client} profile={profile} />} />
    </section>
  );
}
