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
  const listed = parsedNames(reply.slice(at + 1));
  return listed === undefined ? undefined : [...new Set([...blocks, ...listed])];
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
 * tool names stored with each agent call. The agent calls are those whose instructions differ from the router's (the first call's); a piece that cannot be established is `unverified`, never `passed`.
 */
export function gateEvidenceOf(records: TurnRecords, expected: { readonly reads: number; readonly sourceId: string }, allowed: readonly string[]): GateEvidence {
  const allowedSet = new Set(allowed);
  const read = records.events.filter((event) => !MODEL_OR_TURN.test(event.action) && event.sourceId === expected.sourceId);
  const gateEvents = read.filter((event) => event.result === 'success' || event.result === 'partial').length;
  const failedEvents = read.length - gateEvents;
  const gated = { verdict: (records.run === undefined ? 'unverified' : expected.reads === 0 ? 'passed' : gateEvents >= expected.reads ? 'passed' : 'failed') as PieceVerdict, reads: expected.reads, gateEvents, failedEvents };
  const routerSha = records.calls[0]?.instructionsSha256;
  const agentCalls = records.calls.filter((call) => routerSha !== undefined && call.instructionsSha256 !== routerSha);
  const parsed = agentCalls.map((call) => (call.replyText === null ? [] : calledIn(call.replyText)));
  const unparsed = parsed.filter((names) => names === undefined).length;
  const calledNames = [...new Set(parsed.flatMap((names) => names ?? []))].sort();
  const calledOutside = calledNames.filter((name) => !allowedSet.has(name));
  const called = { verdict: (records.run === undefined || unparsed > 0 || agentCalls.length === 0 ? (calledOutside.length > 0 ? 'failed' : 'unverified') : calledOutside.length > 0 ? 'failed' : 'passed') as PieceVerdict, names: calledNames, outside: calledOutside, unparsed };
  const withoutNames = agentCalls.filter((call) => call.toolsOffered === null).length;
  const offeredNames = [...new Set(agentCalls.flatMap((call) => call.toolsOffered ?? []))].sort();
  const offeredOutside = offeredNames.filter((name) => !allowedSet.has(name));
  const offeredVerdict: PieceVerdict = offeredOutside.length > 0 ? 'failed' : records.run === undefined || agentCalls.length === 0 || withoutNames > 0 ? 'unverified' : 'passed';
  return { gated, called, offered: { verdict: offeredVerdict, names: offeredNames, outside: offeredOutside, callsWithoutNames: withoutNames } };
}
