import { answeredData, useShellData } from '../shell/shell-data.js';
import { initialsOf } from './initials.js';

export function RailIdentity() {
  const answer = answeredData(useShellData().me);
  if (answer === undefined) return null;
  if (answer.edition === 'community') return <p className="rail-caption">Local workspace</p>;
  const name = answer.principal.displayName;
  return (
    <span className="rail-initials" role="img" aria-label={name}>
      {initialsOf(name)}
    </span>
  );
}
