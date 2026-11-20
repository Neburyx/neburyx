import { useId } from 'react';
import { ASSISTANT_COPY } from './copy.js';
import { followUpLabel } from './follow-up-label.js';
import type { FollowUp } from './assistant-session.js';

export function FollowUps({ followUps, disabled, onPress }: { readonly followUps: readonly FollowUp[]; readonly disabled: boolean; readonly onPress: (index: number) => void }) {
  const headingId = useId();
  if (followUps.length === 0) return null;
  return (
    <section className="assistant-followups" aria-labelledby={headingId}>
      <h4 id={headingId}>{ASSISTANT_COPY.followUps}</h4>
      <ul>
        {followUps.map((followUp, index) => (
          <li key={index}>
            <button type="button" className="assistant-chip" disabled={disabled} onClick={() => onPress(index)}>
              {followUpLabel(followUp)}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
