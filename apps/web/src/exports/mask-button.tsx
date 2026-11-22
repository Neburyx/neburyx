import { useId } from 'react';
import { MASK_BUTTON, maskHint, MASK_LOCKED_BY_POLICY, MASK_LOCKED_BY_SWITCH, MASK_OFF_STATE, maskOnState } from './copy.js';

export type MaskLock = 'switch' | 'policy';

interface MaskButtonProps {
  readonly on: boolean;
  readonly lock: MaskLock | undefined;
  readonly fields: number | undefined;
  readonly names: readonly string[] | undefined;
  readonly disabled: boolean;
  readonly onToggle: () => void;
}

export function MaskButton({ on, lock, fields, names, disabled, onToggle }: MaskButtonProps) {
  const stateId = useId();
  const hintId = useId();
  const reasonId = useId();
  const reason = lock === 'switch' ? MASK_LOCKED_BY_SWITCH : lock === 'policy' ? MASK_LOCKED_BY_POLICY : undefined;
  return (
    <div className="export-mask">
      <div className="export-mask-row">
      <button type="button" className="export-mask-toggle" aria-pressed={on} disabled={disabled || lock !== undefined} aria-describedby={`${stateId} ${hintId}${reason === undefined ? '' : ` ${reasonId}`}`} onClick={onToggle}>
        {on ? <span aria-hidden="true">✓ </span> : null}
        {MASK_BUTTON}
      </button>
      <p id={stateId} className="export-mask-state">
        {on ? maskOnState(fields) : MASK_OFF_STATE}
      </p>
      </div>
      <p id={hintId} className="export-mask-hint">
        {maskHint(names)}
      </p>
      {reason === undefined ? null : (
        <p id={reasonId} className="export-mask-hint">
          {reason}
        </p>
      )}
    </div>
  );
}
