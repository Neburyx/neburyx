import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useApiClient } from '../api/client-context.js';
import { linkFor } from '../investigations/deep-link.js';
import { LINK_CANNOT_CARRY_ID } from '../investigations/messages.js';
import { openEntity } from '../investigations/open-flow.js';
import { EXPLORE_PATH } from '../shell/navigation.js';
import { answeredData, useShellData } from '../shell/shell-data.js';
import { useClientState, useSessionMask } from '../state/context.js';
import { demoCaseLabel, type DemoCaseEntry } from './demo-case.js';

/** The open that is waiting, shared by every demo button of the page, so the newest activation is the one that counts and an earlier answer is never applied after it. */
let pending: AbortController | undefined;

/** Opens the demo case by going to the address of its deep link, so it takes the path every entity opens by; a reference a path cannot carry is opened through the body of the open request instead. */
export function OpenDemoCase({ entry, label, offered, className }: { readonly entry: DemoCaseEntry; readonly label: string; readonly offered: number; readonly className: string }) {
  const navigate = useNavigate();
  const client = useApiClient();
  const state = useClientState();
  const mask = useSessionMask();
  const principalId = answeredData(useShellData().me)?.principal.id;
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const attempt = useRef<AbortController | undefined>(undefined);
  // leaving the page, or a change of masking, ends this button's own open and no other
  useEffect(() => () => attempt.current?.abort(), []);
  useEffect(() => attempt.current?.abort(), [mask]);

  const open = (): void => {
    const link = { sourceId: entry.sourceId, entityType: entry.entityType, stableId: entry.stableId, caseRef: entry.caseRef };
    const path = linkFor(link);
    if (path !== undefined) return void navigate(path);
    if (principalId === undefined) return setProblem(LINK_CANNOT_CARRY_ID);
    pending?.abort();
    const controller = new AbortController();
    pending = controller;
    attempt.current = controller;
    setProblem(undefined);
    const request = { sourceId: entry.sourceId, entity: { sourceId: entry.sourceId, entityType: entry.entityType, stableId: entry.stableId }, caseRef: entry.caseRef };
    void openEntity(client, state, request, { principalId, mask }, controller.signal).then((answer) => {
      if (controller.signal.aborted) return;
      if (answer.kind === 'held') return;
      if (answer.kind === 'shown') navigate(`${EXPLORE_PATH}/${answer.id}`, { state: { resumed: answer.created === false } });
      else setProblem(LINK_CANNOT_CARRY_ID);
    });
  };

  return (
    <>
      <button type="button" className={className} onClick={open}>
        {demoCaseLabel(label, entry, offered)}
      </button>
      {problem === undefined ? null : <p role="alert">{problem}</p>}
    </>
  );
}
