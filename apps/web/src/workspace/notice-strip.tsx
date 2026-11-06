import type { ReactNode } from 'react';
import { useProfileState } from '../canvas/profile-context.js';
import { FailureNotice } from '../failure-notice.js';
import { retainedFailure, useShellData } from '../shell/shell-data.js';

export function NoticeStrip({ extra }: { readonly extra?: ReactNode }) {
  const { me, sources } = useShellData();
  const profile = useProfileState();
  const principal = retainedFailure(me);
  const sourceList = retainedFailure(sources);
  const profileFailure = retainedFailure(profile.request);
  if (principal === undefined && sourceList === undefined && profileFailure === undefined && extra === undefined) return null;
  return (
    <div className="notice-strip" role="group" aria-label="Notices">
      {principal === undefined ? null : <FailureNotice failure={principal} />}
      {sourceList === undefined ? null : <FailureNotice failure={sourceList} />}
      {profileFailure === undefined ? null : <FailureNotice failure={profileFailure} />}
      {extra}
    </div>
  );
}
