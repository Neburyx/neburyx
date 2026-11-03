import { useId, useState } from 'react';
import { answeredData, useShellData } from '../shell/shell-data.js';

export const LOCK_TOOLTIP = 'Enterprise';

export function LockedControl({ name }: { readonly name: string }) {
  const tooltipId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const edition = answeredData(useShellData().me)?.edition;
  const explained = (hovered || focused) && edition === 'community';
  return (
    <span className="locked-control" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
      <button type="button" className="locked-button" aria-disabled="true" aria-label={`${name}, locked`} aria-describedby={explained ? tooltipId : undefined}>
        <span className="icon icon-lock" aria-hidden="true" />
        {name}
      </button>
      {explained ? (
        <span role="tooltip" id={tooltipId} className="lock-tooltip">
          {LOCK_TOOLTIP}
        </span>
      ) : null}
    </span>
  );
}
