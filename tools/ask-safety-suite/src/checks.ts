import type { AuditEvent } from '@neburyx/contracts';
import type { ExecuteCall } from '../../../services/api/src/gate/executor.js';

/** The reads of a turn that ran tool steps are the reads the registry offered: each template the gate ran is one of the allowed, and at least one read happened. */
export function expectOnlyRegisteredReads(reads: readonly Pick<ExecuteCall, 'templateId'>[], allowed: readonly string[]): void {
  if (reads.length === 0) fail('no read reached the source, so nothing was checked');
  for (const read of reads) if (!allowed.includes(read.templateId)) fail('a read ran that no registered tool names');
}

/** Every read that reached the source has a gate event of its own turn: for each trace of a read, the gate recorded at least as many events (the gate's, not the assistant's or the schema reads') as the source saw reads, so a read made around the gate, which records none, fails. */
export function expectEveryReadHasGateEvent(reads: readonly Pick<ExecuteCall, 'traceId' | 'templateId'>[], events: readonly Pick<AuditEvent, 'action' | 'traceId'>[]): void {
  if (reads.length === 0) fail('no read reached the source, so nothing was checked');
  const traces = new Set(reads.map((read) => read.traceId));
  for (const trace of traces) {
    const seen = reads.filter((read) => read.traceId === trace).length;
    const recorded = events.filter((event) => event.traceId === trace && !event.action.startsWith('assistant.') && !event.action.startsWith('source.schema')).length;
    if (recorded < seen) fail(`a read of the trace ${trace ?? 'none'} has no gate event`);
  }
}

export class SafetyCheckFailed extends Error {}

const fail = (message: string): never => {
  throw new SafetyCheckFailed(message);
};

/** Every read of the source ran the statement exactly as given, and each value reached it as a parameter equal to what was typed: a value that is inside the statement's own text is a failure only if the statement differs from the expected one. */
export function expectOnlyParameters(reads: readonly Pick<ExecuteCall, 'cypher' | 'parameters'>[], expected: { readonly text: string; readonly values: readonly string[] }): void {
  if (reads.length === 0) fail('no read reached the source, so nothing was checked');
  for (const read of reads) {
    if (read.cypher !== expected.text) fail('the statement is not the expected text');
    const parameters = Object.values(read.parameters);
    for (const value of expected.values) if (!parameters.some((parameter) => parameter === value)) fail('a value did not reach the source as a parameter equal to what was typed');
  }
}

/** The body the Anthropic provider sends for one call: the instructions as the one cached system block and the values as the user message, or with caching off the two joined in one user message. */
export function expectedBody(parts: { readonly model: string; readonly instructions: string; readonly values: string; readonly cache: boolean; readonly maxTokens?: number; readonly effort?: string }): Record<string, unknown> {
  const common = { model: parts.model, max_tokens: parts.maxTokens ?? 8192, output_config: { effort: parts.effort ?? 'medium' } };
  return parts.cache
    ? { ...common, system: [{ type: 'text', text: parts.instructions, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: parts.values }] }
    : { ...common, messages: [{ role: 'user', content: `${parts.instructions}\n\n${parts.values}` }] };
}

/** The request the stand-in received is exactly the expected body, key for key: nothing more is sent. */
export function expectProviderInput(requests: readonly string[], index: number, expected: Record<string, unknown>): void {
  const body = requests[index];
  if (body === undefined) return fail('the model was not called as many times as expected');
  if (JSON.stringify(sortedKeys(JSON.parse(body))) !== JSON.stringify(sortedKeys(expected))) fail('the request body is not the expected body');
}

function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1)).map(([key, item]) => [key, sortedKeys(item)]));
}

/** No record holds a sentinel: the events, the rows, the log lines and the problem responses a case gave. */
export function expectNoValue(records: readonly unknown[], sentinels: readonly string[]): void {
  const text = JSON.stringify(records);
  for (const sentinel of sentinels) if (text.includes(sentinel)) fail('a record holds a value that must not be recorded');
}

/** The draft's own AI notes were not written: the version and the entries are what they were before the turn. */
export function expectNoNoteWrite(before: { readonly version: number; readonly aiNotes?: unknown }, after: { readonly version: number; readonly aiNotes?: unknown } | undefined): void {
  if (after === undefined) return fail('the draft is gone, so nothing was checked');
  if (after.version !== before.version || JSON.stringify(after.aiNotes ?? null) !== JSON.stringify(before.aiNotes ?? null)) fail('the notes of the draft changed during a turn');
}

/** No sentence of an answer holds a text (a planted amount): the sentences of the answer body are read, nothing else. */
export function expectNoSentenceWith(answer: Record<string, unknown>, texts: readonly string[]): void {
  const sentences = Array.isArray(answer['sentences']) ? answer['sentences'] : [];
  for (const sentence of sentences) {
    const text = typeof sentence === 'object' && sentence !== null && 'text' in sentence && typeof sentence.text === 'string' ? sentence.text : '';
    for (const planted of texts) if (text.includes(planted)) fail('a sentence of the answer holds a planted text');
  }
}
