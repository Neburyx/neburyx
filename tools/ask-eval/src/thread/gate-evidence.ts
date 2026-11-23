import type { TurnRecords } from './records.js';

type PieceVerdict = 'passed' | 'failed' | 'unverified';

export interface GateEvidence {
  /** Every read the answer lists reached the source through the gate: each has a gate audit event of the turn. */
  readonly gated: { readonly verdict: PieceVerdict; readonly reads: number; readonly gateEvents: number };
  /** The tools the model called in its agent calls are all on the allowlist. */
  readonly called: { readonly verdict: PieceVerdict; readonly names: readonly string[]; readonly outside: readonly string[] };
  /** The tools the model was offered, from the names stored with each agent call, are all on the allowlist; a call without stored names leaves this unverified, and a build result alone never passes it. */
  readonly offered: { readonly verdict: PieceVerdict; readonly names: readonly string[]; readonly outside: readonly string[]; readonly callsWithoutNames: number };
}

const MODEL_OR_TURN = /^(assistant\.(route|agent|turn\.)|ai\.)/u;
const TOOL_USE = /"type"\s*:\s*"tool_use"[^}]*?"name"\s*:\s*"([^"]+)"|"name"\s*:\s*"([^"]+)"\s*,\s*"input"/gu;

/** The names of the tools a reply of the model called. */
function calledIn(reply: string): string[] {
  const names: string[] = [];
  for (const match of reply.matchAll(TOOL_USE)) {
    const name = match[1] ?? match[2];
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * The three pieces of evidence for the criterion that no read bypasses the gate and no tool outside the allowed ones was offered or called: gate events against the reads of the answer, tool names called, and the tool names
 * stored with each agent call. A piece that cannot be established is `unverified`, never `passed`.
 */
export function gateEvidenceOf(records: TurnRecords, reads: number, allowed: readonly string[]): GateEvidence {
  const allowedSet = new Set(allowed);
  const gateEvents = records.events.filter((event) => !MODEL_OR_TURN.test(event.action)).length;
  const gated = { verdict: (records.run === undefined ? 'unverified' : reads === 0 ? 'passed' : gateEvents >= reads ? 'passed' : 'failed') as PieceVerdict, reads, gateEvents };
  // the router call (the first) names no tools; the agent calls are those with replies that call tools
  const calledNames = [...new Set(records.calls.flatMap((call) => (call.replyText === null ? [] : calledIn(call.replyText))))].sort();
  const calledOutside = calledNames.filter((name) => !allowedSet.has(name));
  const called = { verdict: (records.run === undefined ? 'unverified' : calledOutside.length > 0 ? 'failed' : 'passed') as PieceVerdict, names: calledNames, outside: calledOutside };
  const agentCalls = records.calls.filter((call) => call.toolsOffered !== null || (call.replyText !== null && calledIn(call.replyText).length > 0));
  const withoutNames = agentCalls.filter((call) => call.toolsOffered === null).length;
  const offeredNames = [...new Set(agentCalls.flatMap((call) => call.toolsOffered ?? []))].sort();
  const offeredOutside = offeredNames.filter((name) => !allowedSet.has(name));
  const offeredVerdict: PieceVerdict = records.run === undefined || agentCalls.length === 0 || withoutNames > 0 ? 'unverified' : offeredOutside.length > 0 ? 'failed' : 'passed';
  return { gated, called, offered: { verdict: offeredVerdict, names: offeredNames, outside: offeredOutside, callsWithoutNames: withoutNames } };
}
