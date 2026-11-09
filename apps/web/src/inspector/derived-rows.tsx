import { useEffect } from 'react';
import type { DerivedNeighborsResult, ElementRef } from '@neburyx/contracts';
import type { DerivedStore } from '../api/derived-store.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { FailureNotice, canRetry } from '../failure-notice.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { useDerivedStoreWhenProvided } from '../workspace/derived-context.js';
import { RETRY } from '../workspace/expand-copy.js';
import { formatNumber } from '../workspace/scope-text.js';
import { COUNTING_DERIVED, LINKED } from './copy.js';
import { derivedCountText, showLabel } from './derived-text.js';

interface Rule {
  readonly id: string;
  readonly to: string;
}

function addedText(nodes: number): string {
  if (nodes === 0) return 'Already shown';
  return `${formatNumber(nodes)} ${nodes === 1 ? 'neighbor' : 'neighbors'} added`;
}

function ResultRow({ store, entity, name, result }: { readonly store: DerivedStore; readonly entity: ElementRef; readonly name: string; readonly result: DerivedNeighborsResult }) {
  const state = useClientState();
  const text = `${LINKED} ${name} · ${derivedCountText(result.count)}`;
  const canShow = result.nodes.length > 0;
  return (
    <div role="group" className="inspector-row inspector-derived-row" aria-label={`${text} (${result.ruleId})`}>
      <span>{text}</span>
      {canShow ? (
        <button
          type="button"
          className="neighbor-types-link"
          aria-label={`${showLabel(result.count)} ${name} (${result.ruleId})`}
          onClick={() => {
            const outcome = store.show(entity, result.ruleId);
            if (outcome !== undefined) state.presentation.announceMove(outcome.focusNote ?? addedText(outcome.nodes));
          }}
        >
          {showLabel(result.count)}
        </button>
      ) : null}
    </div>
  );
}

function Rows({ store, entity, rules, mask }: { readonly store: DerivedStore; readonly entity: ElementRef; readonly rules: readonly Rule[]; readonly mask: boolean }) {
  const profile = useProfileWhenProvided();
  const request = store.forNode(entity, mask);
  const state = useStoreSelector(request, (current) => current);
  useEffect(() => {
    // a read the person cancelled stays idle in the session's store; showing the entity again asks again
    if (request.getState().phase === 'idle') request.reload();
    // showing another entity stops the read of this one, as the entity read is stopped; the answer of a read that finished stays held
    return () => {
      if (request.getState().phase === 'loading') request.cancel();
    };
  }, [request]);
  const nameOf = (type: string): string => profile?.entityTypes.find((entry) => entry.type === type)?.displayName ?? type;
  if (state.phase === 'failed') {
    return (
      <div className="inspector-derived">
        <FailureNotice failure={state.failure} />
        {canRetry(state.failure) ? (
          <button type="button" className="neighbor-types-link" onClick={request.reload}>
            {RETRY}
          </button>
        ) : null}
      </div>
    );
  }
  if (state.phase !== 'ready') return <p role="status">{COUNTING_DERIVED}</p>;
  return (
    <div className="inspector-derived">
      {rules.flatMap((rule) => {
        const result = state.data.results.find((entry) => entry.ruleId === rule.id);
        return result === undefined ? [] : [<ResultRow key={rule.id} store={store} entity={entity} name={nameOf(rule.to)} result={result} />];
      })}
    </div>
  );
}

/** The rule-derived rows of the Overview's neighbors: one for each rule of the source whose first type is the entity's; none, and no read, for a source with no such rule. */
export function DerivedNeighborRows({ entity }: { readonly entity: ElementRef }) {
  const store = useDerivedStoreWhenProvided();
  const profile = useProfileWhenProvided();
  const mask = useSessionMask();
  const rules = profile?.derivedRules.filter((rule) => rule.from === entity.entityType) ?? [];
  if (store === undefined || rules.length === 0) return null;
  return <Rows store={store} entity={entity} rules={rules} mask={mask} />;
}

