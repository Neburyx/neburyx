import type { SourceState } from '@neburyx/contracts';
import { STATE_WORDS } from './copy.js';

export function StatePill({ state }: { readonly state: SourceState }) {
  return <span className={`pill pill-${state}`}>{STATE_WORDS[state]}</span>;
}
