import { FailureBox } from '../failure-box.js';
import { RETRY_NAMES } from '../failure-copy.js';
import { answeredData, retainedFailure, useShellData } from './shell-data.js';

export function IdentityBlock() {
  const { me, reloadMe } = useShellData();
  const failure = retainedFailure(me);
  return (
    <section aria-label="Identity">
      {failure !== undefined ? <FailureBox failure={failure} retry={{ name: RETRY_NAMES.account, run: reloadMe }} /> : answeredData(me) === undefined ? <p role="status">Loading</p> : <p>Local workspace</p>}
    </section>
  );
}
