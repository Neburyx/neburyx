import type { ReactNode } from 'react';
import type { ApiFailure } from '../api/client.js';
import { useProfileReload, useProfileState } from '../canvas/profile-context.js';
import { RetryButton } from '../failure-box.js';
import { RETRY_NAMES } from '../failure-copy.js';
import { FailureNotice, offersRetry } from '../failure-notice.js';
import { retainedFailure, useShellData } from '../shell/shell-data.js';

interface Notice {
  readonly lead: string;
  readonly failure: ApiFailure;
  readonly retryName: string;
  readonly retry: () => void;
}

export function NoticeStrip({ extra }: { readonly extra?: ReactNode }) {
  const { me, sources, reloadMe, reloadSources } = useShellData();
  const profile = useProfileState();
  const reloadProfile = useProfileReload();
  const read = [
    { lead: 'Sources ·', failure: retainedFailure(sources), retryName: RETRY_NAMES.sources, retry: reloadSources },
    { lead: 'Source profile ·', failure: retainedFailure(profile.request), retryName: RETRY_NAMES.sourceProfile, retry: reloadProfile },
    { lead: 'Your account ·', failure: retainedFailure(me), retryName: RETRY_NAMES.account, retry: reloadMe },
  ];
  const notices = read.flatMap((notice): Notice[] => (notice.failure === undefined ? [] : [{ ...notice, failure: notice.failure }]));
  if (notices.length === 0 && extra === undefined) return null;
  return (
    <div className="notice-strip" role="group" aria-label="Notices">
      {notices.length === 0 ? null : (
        <div className="notice-rows">
          {notices.map((notice) => (
            <div key={notice.lead} className="notice-row">
              <div className="notice-text">
                <span className="notice-lead">{notice.lead}</span>
                <FailureNotice failure={notice.failure} />
              </div>
              {offersRetry(notice.failure) ? <RetryButton failure={notice.failure} name={notice.retryName} run={notice.retry} /> : <span />}
            </div>
          ))}
        </div>
      )}
      {extra}
    </div>
  );
}
