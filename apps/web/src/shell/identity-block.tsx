import { FailureNotice } from '../failure-notice.js';
import { answeredData, retainedFailure, useShellData } from './shell-data.js';

export function IdentityBlock() {
  const { me } = useShellData();
  const answer = answeredData(me);
  const failure = retainedFailure(me);
  return (
    <section aria-label="Identity">
      {answer === undefined ? (
        failure === undefined ? (
          <p role="status">Loading</p>
        ) : null
      ) : (
        <>
          <p>Local workspace</p>
          <p>Community edition</p>
        </>
      )}
      {failure === undefined ? null : <FailureNotice failure={failure} />}
    </section>
  );
}
