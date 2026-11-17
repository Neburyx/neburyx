import { describe, expect, it } from 'vitest';
import { extensionWanted, readAiEnablement, type AiEnablement } from './ai-enablement.js';

const read = (env: Record<string, string | undefined>): AiEnablement => {
  const result = readAiEnablement(env);
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.enablement;
};

describe('the AI features that are on', () => {
  it('are all on with a provider key and nothing else', () => {
    expect(read({ NEBURYX_ASK_API_KEY: 'k' })).toEqual({ providerConfigured: true, ask: true, summary: true, assistant: true });
  });

  it('count a key file as a provider, and an empty key or file as none', () => {
    expect(read({ NEBURYX_ASK_API_KEY_FILE: '/run/key' }).providerConfigured).toBe(true);
    expect(read({ NEBURYX_ASK_API_KEY: '', NEBURYX_ASK_API_KEY_FILE: '' }).providerConfigured).toBe(false);
  });

  it('turn one feature off by `off`, and treat unset, empty and `on` as on', () => {
    const off = read({ NEBURYX_ASK_API_KEY: 'k', NEBURYX_ASK_ENABLED: 'off', NEBURYX_SUMMARY_ENABLED: '', NEBURYX_ASSISTANT_ENABLED: 'on' });
    expect([off.ask, off.summary, off.assistant]).toEqual([false, true, true]);
  });

  it('refuse any other value, naming the variable and never the value, when a provider is configured', () => {
    const result = readAiEnablement({ NEBURYX_ASK_API_KEY: 'k', NEBURYX_SUMMARY_ENABLED: 'SENTINEL-VALUE', NEBURYX_ASK_ENABLED: 'yes' });
    expect(result).toEqual({ ok: false, problems: ['NEBURYX_ASK_ENABLED must be on or off', 'NEBURYX_SUMMARY_ENABLED must be on or off'] });
    expect(JSON.stringify(result)).not.toContain('SENTINEL-VALUE');
  });

  it('ignore a bad value when no provider is configured', () => {
    expect(read({ NEBURYX_ASK_ENABLED: 'SENTINEL-VALUE' }).providerConfigured).toBe(false);
  });
});

describe('whether the extension is loaded', () => {
  const on = { providerConfigured: true, ask: true, summary: true, assistant: true };

  it('is loaded for a provider with Ask or the summary on', () => {
    expect(extensionWanted(on, false)).toBe(true);
    expect(extensionWanted({ ...on, ask: false }, false)).toBe(true);
    expect(extensionWanted({ ...on, summary: false }, false)).toBe(true);
  });

  it('is not loaded with no provider, or with Ask and the summary both off, whatever the assistant holds', () => {
    expect(extensionWanted({ ...on, providerConfigured: false }, false)).toBe(false);
    expect(extensionWanted({ ...on, ask: false, summary: false }, false)).toBe(false);
  });

  it('is loaded when the old switch is on, whatever else holds', () => {
    expect(extensionWanted({ providerConfigured: false, ask: true, summary: true, assistant: true }, true)).toBe(true);
    expect(extensionWanted({ ...on, ask: false, summary: false }, true)).toBe(true);
  });
});
