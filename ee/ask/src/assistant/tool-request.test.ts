import type { AskSourceFolder } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { buildToolRegistry } from './tool-registry.js';
import { decideToolReply, readToolRequest } from './tool-request.js';

const source: AskSourceFolder = {
  classification: { text: 'Choose the intent.', sha256: 'a'.repeat(64) },
  intents: [
    { name: 'byId', parameters: ['id'], kind: 'query', query: { text: 'MATCH (n) RETURN n', sha256: 'b'.repeat(64) } },
    { name: 'gone', parameters: ['id'], kind: 'template', template: 'withdrawn-template', settings: {} },
  ],
};
const registry = buildToolRegistry({ source, patterns: undefined, viewReadable: true, templateRunnable: () => false });
const request = (over: Record<string, unknown> = {}): string => JSON.stringify({ tool: 'byId', values: { id: 'W-1' }, ...over });

describe('reading a tool request strictly', () => {
  it.each([
    ['text around the JSON', `Here you go: ${request()}`],
    ['a code fence', `\`\`\`json\n${request()}\n\`\`\``],
    ['an array', '[]'],
    ['not JSON', 'read the device'],
    ['an extra member', request({ note: 'x' })],
    ['no values', JSON.stringify({ tool: 'byId' })],
    ['a duplicate key', '{"tool":"byId","tool":"view","values":{"id":"W-1"}}'],
    ['a tool that is not text', request({ tool: 5 })],
    ['a tool outside the registry', request({ tool: 'dropEverything' })],
    ['a value missing', request({ values: {} })],
    ['an extra value', request({ values: { id: 'W-1', other: 'x' } })],
    ['a value that is not text', request({ values: { id: 7 } })],
    ['an empty value', request({ values: { id: '  ' } })],
    ['a value over the limit', request({ values: { id: 'x'.repeat(257) } })],
    ['values that are not an object', request({ values: 'W-1' })],
    ['a reply over the limit', request({ values: { id: 'x' }, pad: 'y'.repeat(5000) })],
  ])('refuses %s as malformed and runs nothing', (_label, text) => {
    expect(readToolRequest(text, registry)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('says a tool of the registry whose template can no longer run is unavailable, with any values', () => {
    expect(readToolRequest(JSON.stringify({ tool: 'gone', values: { id: 'W-1' } }), registry)).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('accepts a registered tool with exactly its parameters, and the view with none', () => {
    const read = readToolRequest(request(), registry);
    expect(read.ok && read.request).toMatchObject({ tool: { name: 'byId' }, values: { id: 'W-1' } });
    const view = readToolRequest(JSON.stringify({ tool: 'view', values: {} }), registry);
    expect(view.ok && view.request.tool.name).toBe('view');
  });
});

describe('what the loop does with a read reply', () => {
  const malformed = { ok: false, reason: 'malformed' } as const;
  it.each([
    ['runs a request', { ok: true, request: { tool: { name: 'byId', kind: 'intent', parameters: ['id'], available: true }, values: {} } } as const, { callsUsed: 3, maxCalls: 5, repeated: false }, 'request'],
    ['asks once more for a malformed reply when the calls limit leaves room for the answer', malformed, { callsUsed: 2, maxCalls: 5, repeated: false }, 'repeat'],
    ['ends the turn when the reply was already repeated', malformed, { callsUsed: 2, maxCalls: 5, repeated: true }, 'malformed'],
    ['ends the turn at once when no call is left for the answer', malformed, { callsUsed: 4, maxCalls: 5, repeated: false }, 'malformed'],
    ['does not repeat an unavailable tool', { ok: false, reason: 'unavailable' } as const, { callsUsed: 1, maxCalls: 5, repeated: false }, 'unavailable'],
  ])('%s', (_label, read, turn, expected) => {
    expect(decideToolReply(read, turn)).toBe(expected);
  });
});
