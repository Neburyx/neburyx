import type { TurnRecords } from './records.js';

type PieceVerdict = 'passed' | 'failed' | 'unverified';

export interface GateEvidence {
  /** Every read the answer lists reached the source through the gate: the gate events of the turn that read the source of the turn, and ended in success, are at least as many as the reads; events that failed are counted apart. */
  readonly gated: { readonly verdict: PieceVerdict; readonly reads: number; readonly gateEvents: number; readonly failedEvents: number };
  /** The tools the model called in its agent calls are all on the allowlist; a reply whose tool calls cannot be parsed leaves this unverified. */
  readonly called: { readonly verdict: PieceVerdict; readonly names: readonly string[]; readonly outside: readonly string[]; readonly unparsed: number };
  /** The tools the model was offered, from the names stored with each agent call, are all on the allowlist; an agent call without stored names leaves this unverified, and a build result alone never passes it. */
  readonly offered: { readonly verdict: PieceVerdict; readonly names: readonly string[]; readonly outside: readonly string[]; readonly callsWithoutNames: number };
}

const MODEL_OR_TURN = /^(assistant\.|ai\.)/u;
const TOOL_CALLS_AT = ' [{"name":';

/** The tool names a stored reply holds: the text of the reply, then the calls as the audited model writes them (a JSON list of name and args); undefined when a list is there and cannot be read. */
function calledIn(reply: string): readonly string[] | undefined {
  const blocks = [...reply.matchAll(/"type"\s*:\s*"tool_use"[^}]*?"name"\s*:\s*"([^"]+)"/gu)].flatMap((match) => (match[1] === undefined ? [] : [match[1]]));
  const at = reply.lastIndexOf(TOOL_CALLS_AT);
  if (at < 0) return reply.startsWith(TOOL_CALLS_AT.trimStart()) ? parsedNames(reply) : blocks;
  return parsedNames(reply.slice(at + 1));
}

function parsedNames(list: string): readonly string[] | undefined {
  try {
    const parsed: unknown = JSON.parse(list);
    if (!Array.isArray(parsed)) return undefined;
    const names: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null || !('name' in entry) || typeof entry.name !== 'string') return undefined;
      names.push(entry.name);
    }
    return names;
  } catch {
    return undefined;
  }
}

/**
 * The three pieces of evidence for the criterion that no read bypasses the gate and no tool outside the allowed ones was offered or called: gate events of the turn against the reads of the answer, tool names called, and the
 * tool names stored with each agent call. An agent call is one that was bound to tools (names stored) or whose reply calls tools, so the router, a view answer and the overview of a refusal are not; a turn that made no agent call
 * and has complete records passes with none called or offered. A piece that cannot be established, or whose records are incomplete, is `unverified`, never `passed`.
 */
export function gateEvidenceOf(records: TurnRecords, expected: { readonly reads: number; readonly sourceId: string }, allowed: readonly string[], withoutGate: readonly string[]): GateEvidence {
  const allowedSet = new Set(allowed);
  const read = records.events.filter((event) => !MODEL_OR_TURN.test(event.action) && event.sourceId === expected.sourceId);
  const gateEvents = read.filter((event) => event.result === 'success' || event.result === 'partial').length;
  const failedEvents = read.length - gateEvents;
  const agentCalls = records.calls.filter((call) => call.toolsOffered !== null || (call.replyText !== null && (calledIn(call.replyText)?.length ?? 1) > 0));
  const incomplete = records.run === undefined || records.problems.length > 0;
  const parsed = agentCalls.map((call) => (call.replyText === null ? [] : calledIn(call.replyText)));
  const readsMade = parsed.flatMap((names) => names ?? []).filter((name) => !withoutGate.includes(name)).length;
  const reads = Math.max(expected.reads, readsMade);
  const gatedVerdict: PieceVerdict = incomplete ? 'unverified' : reads === 0 || gateEvents >= reads ? 'passed' : 'failed';
  const unparsed = parsed.filter((names) => names === undefined).length;
  const gated = { verdict: gatedVerdict, reads, gateEvents, failedEvents };
  const calledNames = [...new Set(parsed.flatMap((names) => names ?? []))].sort();
  const calledOutside = calledNames.filter((name) => !allowedSet.has(name));
  const calledVerdict: PieceVerdict = calledOutside.length > 0 ? 'failed' : incomplete || unparsed > 0 ? 'unverified' : 'passed';
  const called = { verdict: calledVerdict, names: calledNames, outside: calledOutside, unparsed };
  const withoutNames = agentCalls.filter((call) => call.toolsOffered === null).length;
  const offeredNames = [...new Set(agentCalls.flatMap((call) => call.toolsOffered ?? []))].sort();
  const offeredOutside = offeredNames.filter((name) => !allowedSet.has(name));
  const offeredVerdict: PieceVerdict = offeredOutside.length > 0 ? 'failed' : incomplete || withoutNames > 0 ? 'unverified' : 'passed';
  return { gated, called, offered: { verdict: offeredVerdict, names: offeredNames, outside: offeredOutside, callsWithoutNames: withoutNames } };
}
