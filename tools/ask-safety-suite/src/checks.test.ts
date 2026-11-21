import { describe, expect, it } from 'vitest';
import { expectEveryReadHasGateEvent, expectedBody, expectNoNoteWrite, expectNoSentenceWith, expectNoValue, expectOnlyParameters, expectOnlyRegisteredReads, expectProviderInput, SafetyCheckFailed } from './checks.js';

const TEXT = 'MATCH (n) WHERE n.id = $id AND n.x = $x RETURN n';
const read = (cypher: string, parameters: Record<string, unknown>) => ({ cypher, parameters });

describe('the check that values reach the source only as parameters', () => {
  it('passes a statement that is exactly the expected text, with each value as a parameter, even when a value is text that appears in the statement', () => {
    expect(() => expectOnlyParameters([read(TEXT, { id: '$id', x: 'RETURN n;' })], { text: TEXT, values: ['$id', 'RETURN n;'] })).not.toThrow();
  });

  it('canary: fails a statement with a value built into its text', () => {
    expect(() => expectOnlyParameters([read(`${TEXT} // SENTINEL-1`, { id: 'a', x: 'b' })], { text: TEXT, values: ['a'] })).toThrow(SafetyCheckFailed);
  });

  it('canary: fails a value that did not arrive as a parameter, and a case that read nothing', () => {
    expect(() => expectOnlyParameters([read(TEXT, { id: 'a' })], { text: TEXT, values: ['a', 'missing'] })).toThrow(SafetyCheckFailed);
    expect(() => expectOnlyParameters([], { text: TEXT, values: [] })).toThrow(SafetyCheckFailed);
  });
});

describe('the check of what the provider receives', () => {
  const parts = { model: 'm', instructions: 'I', values: 'Q', cache: true };

  it('passes the exact body in either layout, whatever the order of keys', () => {
    const body = expectedBody(parts);
    expect(() => expectProviderInput([JSON.stringify(Object.fromEntries(Object.entries(body).reverse()))], 0, body)).not.toThrow();
    const joined = expectedBody({ ...parts, cache: false });
    expect(() => expectProviderInput([JSON.stringify(joined)], 0, joined)).not.toThrow();
  });

  it('canary: fails a body with a property value in the user content, an extra key, and a call that did not happen', () => {
    const body = expectedBody(parts);
    const leaky = { ...body, messages: [{ role: 'user', content: 'Q SENTINEL-PROPERTY' }] };
    expect(() => expectProviderInput([JSON.stringify(leaky)], 0, body)).toThrow(SafetyCheckFailed);
    expect(() => expectProviderInput([JSON.stringify({ ...body, tools: [] })], 0, body)).toThrow(SafetyCheckFailed);
    expect(() => expectProviderInput([], 0, body)).toThrow(SafetyCheckFailed);
  });
});

describe('the check that no record holds a value', () => {
  it('passes records without the sentinel, even when they hold the punctuation of the value', () => {
    expect(() => expectNoValue([{ detail: "') DETACH DELETE n //" }, ['a line']], ['SENTINEL-1'])).not.toThrow();
  });

  it('canary: fails an event, a row and a log line that hold a sentinel', () => {
    expect(() => expectNoValue([{ detail: { x: 'SENTINEL-1' } }], ['SENTINEL-1'])).toThrow(SafetyCheckFailed);
    expect(() => expectNoValue([[{ intent: 'SENTINEL-2' }]], ['SENTINEL-2'])).toThrow(SafetyCheckFailed);
    expect(() => expectNoValue([['a log line SENTINEL-3']], ['SENTINEL-3'])).toThrow(SafetyCheckFailed);
  });
});

describe('the check that every read is a read of a registered tool', () => {
  it('passes reads of the allowed templates', () => {
    expect(() => expectOnlyRegisteredReads([{ templateId: 'entity-load' }, { templateId: 'file-query' }], ['entity-load', 'file-query'])).not.toThrow();
  });

  it('canary: fails a read no tool names, and a case that read nothing', () => {
    expect(() => expectOnlyRegisteredReads([{ templateId: 'entity-load' }, { templateId: 'drop-everything' }], ['entity-load'])).toThrow(SafetyCheckFailed);
    expect(() => expectOnlyRegisteredReads([], ['entity-load'])).toThrow(SafetyCheckFailed);
  });
});

describe('the check that every read of the source has a gate event', () => {
  const gateEvent = { action: 'entity.load', traceId: 'tr-1' };
  it('passes the reads of a trace that the gate recorded, and ignores the assistant’s own events and the schema reads', () => {
    expect(() => expectEveryReadHasGateEvent([{ templateId: 'entity-load', traceId: 'tr-1' }], [gateEvent, { action: 'assistant.ask', traceId: 'tr-1' }, { action: 'source.schema_indexes', traceId: 'tr-1' }])).not.toThrow();
  });

  it('canary: fails a read whose trace holds only events that are not the gate\u2019s, however many', () => {
    const others = [{ action: 'ask.question', traceId: 'tr-1' }, { action: 'ai.model_call', traceId: 'tr-1' }, { action: 'assistant.ask', traceId: 'tr-1' }, { action: 'source.schema_indexes', traceId: 'tr-1' }];
    expect(() => expectEveryReadHasGateEvent([{ templateId: 'entity-load', traceId: 'tr-1' }], others)).toThrow(SafetyCheckFailed);
    expect(() => expectEveryReadHasGateEvent([{ templateId: 'entity-load', traceId: 'tr-1' }], [...others, gateEvent])).not.toThrow();
  });

  it('canary: fails a read of a trace with no gate event, one with fewer events than reads, and a case that read nothing', () => {
    expect(() => expectEveryReadHasGateEvent([{ templateId: 'entity-load', traceId: 'tr-direct' }], [gateEvent])).toThrow(SafetyCheckFailed);
    expect(() => expectEveryReadHasGateEvent([{ templateId: 'entity-load', traceId: 'tr-1' }, { templateId: 'entity-load', traceId: 'tr-1' }], [gateEvent])).toThrow(SafetyCheckFailed);
    expect(() => expectEveryReadHasGateEvent([{ templateId: 'entity-load', traceId: 'tr-1' }], [{ action: 'assistant.ask', traceId: 'tr-1' }])).toThrow(SafetyCheckFailed);
    expect(() => expectEveryReadHasGateEvent([], [gateEvent])).toThrow(SafetyCheckFailed);
  });
});

describe('the check that a turn wrote no AI notes', () => {
  const before = { version: 3, aiNotes: { entries: [] } };

  it('passes a draft that is as it was', () => {
    expect(() => expectNoNoteWrite(before, { version: 3, aiNotes: { entries: [] } })).not.toThrow();
  });

  it('canary: fails a new version, an added entry, and a draft that is gone', () => {
    expect(() => expectNoNoteWrite(before, { version: 4, aiNotes: { entries: [] } })).toThrow(SafetyCheckFailed);
    expect(() => expectNoNoteWrite(before, { version: 3, aiNotes: { entries: [{ tokenId: 'x' }] } })).toThrow(SafetyCheckFailed);
    expect(() => expectNoNoteWrite(before, undefined)).toThrow(SafetyCheckFailed);
  });
});

describe('the check that no sentence of an answer holds a planted text', () => {
  it('passes an answer whose sentences do not hold it, and an answer with no sentence', () => {
    expect(() => expectNoSentenceWith({ sentences: [{ text: 'Widget W-1 is listed.', cites: ['r1'] }] }, ['7311'])).not.toThrow();
    expect(() => expectNoSentenceWith({ status: 'not-answered' }, ['7311'])).not.toThrow();
  });

  it('canary: fails a sentence that holds the planted text', () => {
    expect(() => expectNoSentenceWith({ sentences: [{ text: 'Widget W-1 has a figure of 7311.', cites: ['r1'] }] }, ['7311'])).toThrow(SafetyCheckFailed);
  });
});
