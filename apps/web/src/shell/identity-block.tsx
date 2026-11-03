import type { MeResponse } from '@neburyx/contracts';
import { FailureNotice } from '../failure-notice.js';
import { answeredData, retainedFailure, useShellData } from './shell-data.js';

const ROLE_NAMES: Readonly<Record<NonNullable<MeResponse['principal']['role']>, string>> = {
  administrator: 'Administrator',
  investigator: 'Investigator',
  viewer: 'Viewer',
};

function Identity({ me }: { readonly me: MeResponse }) {
  if (me.edition === 'community') {
    return (
      <>
        <p>Local workspace</p>
        <p>Community edition</p>
      </>
    );
  }
  return (
    <>
      <p className="identity-name">{me.principal.displayName}</p>
      {me.principal.role === null ? null : <p>{ROLE_NAMES[me.principal.role]}</p>}
    </>
  );
}

export function IdentityBlock() {
  const { me } = useShellData();
  const answer = answeredData(me);
  const failure = retainedFailure(me);
  return (
    <section aria-label="Identity">
      {answer === undefined ? failure === undefined ? <p role="status">Loading</p> : null : <Identity me={answer} />}
      {failure === undefined ? null : <FailureNotice failure={failure} />}
    </section>
  );
}
