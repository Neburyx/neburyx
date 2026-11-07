import { useEffect, useState } from 'react';
import { useRecent, useRecentState } from '../home/recent-context.js';
import { useShellData } from '../shell/shell-data.js';
import { decideStart, type StartPage } from './start-decision.js';

/**
 * The page the start address shows. The list is asked for once per visit here, so Home's own read serves this decision too. A page that is
 * on screen stays while a read is under way or fails, and is replaced only by a decision that follows a successful read.
 */
export function useStartPage(): StartPage | 'loading' {
  const recent = useRecent();
  const { list, readBy } = useRecentState();
  const { sources } = useShellData();
  const [visit] = useState(() => ({}));
  const [settled, setSettled] = useState<number | undefined>(undefined);
  const [chosen, setChosen] = useState<StartPage | undefined>(undefined);

  useEffect(() => recent.ensure(visit), [recent, visit]);

  const asked = readBy === visit;
  const succeeded = asked && list.phase === 'ready' && list.failure === undefined ? list.data.counts.investigations.value : undefined;
  if (succeeded !== undefined && succeeded !== settled) setSettled(succeeded);
  const decision = decideStart({ sources, list, asked, settledCount: succeeded ?? settled });
  if (decision !== 'pending' && decision !== chosen) setChosen(decision);
  return decision === 'pending' ? (chosen ?? 'loading') : decision;
}
