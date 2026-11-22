import { useEffect, useRef } from 'react';
import { useApiClient } from '../api/client-context.js';
import type { GraphNode } from '@neburyx/contracts';
import { FailureNotice } from '../failure-notice.js';
import { TRY_AGAIN } from '../investigations/messages.js';
import { maskSwitchOf } from '../mask/mask-switch.js';
import { useProfileWhenProvided } from '../canvas/profile-context.js';
import { isLockedByPolicy, sensitiveFieldCount } from '../mask/mask-view.js';
import { useClientState, useLoadedGraph, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { fieldsMasked, fieldsShown, LOCKED_BY_POLICY, MASK_NOTE, MASK_SWITCH_LABEL, POLICY_NOTE, REREADING_VIEW, REREAD_FAILED } from './copy.js';

let keepFocus = false;

/** Whether a policy locks the switch: a policy-masked property in the loaded graph or in the entity shown. */
function useLockedByPolicy(node?: GraphNode): boolean {
  const graph = useLoadedGraph();
  return isLockedByPolicy(graph) || (node?.properties.some((property) => property.maskedBy === 'policy') ?? false);
}

/** The note under the property list: the pii rule, or why the switch is locked. */
export function MaskNote({ node }: { readonly node?: GraphNode | undefined }) {
  return <p id="inspector-mask-note" className="inspector-mask-note">{useLockedByPolicy(node) ? POLICY_NOTE : MASK_NOTE}</p>;
}

/** The masking switch of the Properties tab. The tab is drawn again when the view is read again, so a toggle by the person leaves a mark that the next switch drawn takes the focus. */
export function MaskControl({ node }: { readonly node?: GraphNode | undefined }) {
  const state = useClientState();
  const maskSwitch = maskSwitchOf(state, useApiClient());
  const mask = useSessionMask();
  const graph = useLoadedGraph();
  const profile = useProfileWhenProvided();
  const locked = useLockedByPolicy(node);
  const shown = mask || locked;
  const read = useStoreSelector(maskSwitch.status, (current) => current);
  const input = useRef<HTMLInputElement>(null);
  const reading = read.kind === 'reading';
  const settled = read.kind === 'idle';
  const count = sensitiveFieldCount(profile, graph);
  const hasCaption = locked || (settled && count !== undefined);
  useEffect(() => {
    if (!keepFocus || reading) return;
    keepFocus = false;
    input.current?.focus();
  }, [reading]);
  return (
    <div className="inspector-mask">
      <label className="inspector-mask-card" data-locked={locked ? 'true' : undefined}>
        <span className="inspector-mask-text">
          <span id="inspector-mask-label" className="inspector-mask-label">{MASK_SWITCH_LABEL}</span>
          {locked ? (
            <span id="inspector-mask-caption" className="inspector-mask-caption">{LOCKED_BY_POLICY}</span>
          ) : settled && count !== undefined ? (
            <span id="inspector-mask-caption" className="inspector-mask-caption">{shown ? fieldsMasked(count) : fieldsShown(count)}</span>
          ) : null}
        </span>
        <input
          ref={input}
          className="inspector-mask-toggle"
          type="checkbox"
          role="switch"
          checked={shown}
          disabled={reading}
          aria-disabled={locked ? true : undefined}
          aria-labelledby="inspector-mask-label"
          aria-describedby={hasCaption ? 'inspector-mask-caption inspector-mask-note' : 'inspector-mask-note'}
          onChange={(event) => {
            if (locked) return;
            keepFocus = true;
            maskSwitch.turn(event.target.checked);
          }}
        />
      </label>
      {reading ? <p role="status">{REREADING_VIEW}</p> : null}
      {read.kind === 'failed' ? (
        <div role="group" aria-label={REREAD_FAILED}>
          <FailureNotice failure={read.failure} />
          <button type="button" className="secondary" onClick={maskSwitch.retry}>
            {TRY_AGAIN}
          </button>
        </div>
      ) : null}
    </div>
  );
}
