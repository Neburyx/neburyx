import { afterAll, beforeAll, describe, it } from 'vitest';
import { createLocalProvider } from './local.js';
import { CONFORMANCE_CASES, type ConformanceScenario } from './testing/conformance.js';
import { completion, json, startLocalStub, type LocalReply, type LocalStub } from './testing/local-stub.js';

const SCENARIOS: Readonly<Record<ConformanceScenario, LocalReply>> = {
  'ok-known-usage': json(200, completion()),
  'ok-unknown-usage': json(200, completion({ usage: undefined })),
  refused: json(200, completion({}, { refusal: 'I cannot help with that.', content: '' })),
  timeout: () => undefined,
  'rate-limited': json(429, { error: { type: 'rate_limit_error', message: 'slow down' } }),
  rejected: json(401, { error: { type: 'authentication_error', message: 'no' } }),
  'provider-error': json(500, { error: { type: 'server_error', message: 'broken' } }),
  unreachable: (response) => response.destroy(),
  'bad-reply': json(200, { unexpected: true }),
  truncated: json(200, { ...completion(), choices: [{ index: 0, finish_reason: 'length', message: { role: 'assistant', content: 'cut' } }] }),
  'model-asks-for-a-tool': json(200, { ...completion(), choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'lookup', arguments: '{}' } }] } }] }),
};

let stub: LocalStub;
beforeAll(async () => {
  stub = await startLocalStub();
});
afterAll(async () => {
  await stub.close();
});

describe('the conformance suite on the local provider, over a stub server', () => {
  describe.each(CONFORMANCE_CASES)('$name', (conformanceCase) => {
    it('passes', async () => {
      await conformanceCase.run({
        provider: createLocalProvider({ baseUrl: stub.baseUrl, model: 'local-model', limits: { timeoutMs: 1000, maxTokens: 512 } }),
        arrange: (scenario) => {
          stub.reply = SCENARIOS[scenario];
        },
      });
    });
  });
});
