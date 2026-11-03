import { FailureNotice } from '../failure-notice.js';
import { retainedFailure, useShellData } from '../shell/shell-data.js';

export function NoticeStrip() {
  const { me, sources } = useShellData();
  const principal = retainedFailure(me);
  const sourceList = retainedFailure(sources);
  if (principal === undefined && sourceList === undefined) return null;
  return (
    <div className="notice-strip" role="group" aria-label="Notices">
      {principal === undefined ? null : <FailureNotice failure={principal} />}
      {sourceList === undefined ? null : <FailureNotice failure={sourceList} />}
    </div>
  );
}
