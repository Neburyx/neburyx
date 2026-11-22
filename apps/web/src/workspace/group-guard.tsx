import { useEffect, useRef, useState } from 'react';
import { useProfileOutcomeWhenProvided } from '../canvas/profile-context.js';
import { guardedGroups, type GuardNote } from '../groups/group-guard.js';
import { joinedGroups } from '../groups/group-join.js';
import { useClientState, useLoadedGraph, useSessionMask } from '../state/context.js';
import { useStoreSelector } from '../state/store.js';
import { MASKED_GROUPING_REMOVED, PROFILE_GROUPING_REMOVED, VALUES_CHANGED_REMOVED } from './group-copy.js';

const TEXT: Readonly<Record<GuardNote, string>> = { masked: MASKED_GROUPING_REMOVED, values: VALUES_CHANGED_REMOVED, profile: PROFILE_GROUPING_REMOVED };

/** Keeps the groups in step with the view: an added entity joins the entity-type group of its type when that group held all of the type, and a grouping by a property is removed when it may not stand (masking, a policy, the mapping, changed values, an unreadable profile) and says so; draws nothing while all is well. */
export function GroupGuard() {
  const state = useClientState();
  const graph = useLoadedGraph();
  const masking = useSessionMask();
  const { provided, profile, failed: profileFailed } = useProfileOutcomeWhenProvided();
  const rereading = useStoreSelector(state.rereading, (held) => held);
  const groups = useStoreSelector(state.presentation.view, (current) => current.groups);
  const previous = useRef(graph.nodes);
  const [note, setNote] = useState<GuardNote | undefined>(undefined);
  useEffect(() => {
    const before = previous.current;
    previous.current = graph.nodes;
    const joined = joinedGroups(groups, before, graph.nodes);
    if (joined !== groups) state.presentation.setGroups(joined);
  }, [graph, groups, state]);
  useEffect(() => {
    if (!provided) return;
    const outcome = guardedGroups({ groups, graph, profile, profileFailed, masking, rereading });
    if (outcome.groups === groups) return;
    state.presentation.setGroups(outcome.groups);
    if (outcome.note !== undefined) setNote(outcome.note);
  }, [provided, groups, graph, profile, profileFailed, masking, rereading, state]);
  useEffect(() => {
    if (note === undefined) return undefined;
    const clear = state.investigation.subscribe(() => setNote(undefined));
    return clear;
  }, [note, state]);
  return note === undefined ? null : (
    <p role="status" className="group-notice">
      {TEXT[note]}
    </p>
  );
}
