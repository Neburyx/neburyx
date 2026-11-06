import { answeredData, useShellData } from '../shell/shell-data.js';

export function RailIdentity() {
  const answer = answeredData(useShellData().me);
  return answer === undefined ? null : <p className="rail-caption">Local workspace</p>;
}
