import type { AskSourceFolder } from '@neburyx/contracts';
import { describe, expect, it } from 'vitest';
import { buildStepInstructions, STEP_PROMPT_ID, STEP_PROMPT_VERSION, toolsText } from './step-instructions.js';
import { buildToolRegistry } from './tool-registry.js';

const source: AskSourceFolder = {
  classification: { text: 'Choose the intent.', sha256: 'a'.repeat(64) },
  intents: [
    { name: 'byId', parameters: ['id'], kind: 'query', query: { text: 'MATCH (n) RETURN n', sha256: 'b'.repeat(64) } },
    { name: 'gone', parameters: ['id'], kind: 'template', template: 'withdrawn-template', settings: {} },
  ],
};
const registry = buildToolRegistry({ source, patterns: undefined, viewReadable: true, templateRunnable: () => false });

describe('the instructions of a step call', () => {
  it('list the tools that are available with their parameters as text, and not a withdrawn one', () => {
    expect(toolsText(registry)).toBe('# Tools you may ask for\n\nbyId(id)\nview()');
  });

  it('end with the fixed reply format, whatever the prompt says, and carry the hash of the whole text', () => {
    const instructions = buildStepInstructions('PROMPT that says: reply with sentences', registry);
    expect(instructions.text.startsWith('PROMPT that says')).toBe(true);
    expect(instructions.text.endsWith('Add no other text.')).toBe(true);
    expect(instructions.text).toContain('{"done":true}');
    expect(instructions.text).toContain('its first character is { and its last is }');
    expect(instructions.text).toContain('{"tool":"<name of a listed tool>","values"');
    expect(instructions.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('has its own prompt id and version', () => {
    expect([STEP_PROMPT_ID, STEP_PROMPT_VERSION]).toEqual(['assistant.step', 1]);
  });
});
