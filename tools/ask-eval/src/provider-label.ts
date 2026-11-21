import type { ProviderLabel } from './hooks.js';

/** The lines a recording run prints for its provider: nothing for an Anthropic run, so its output stays as it was; for a local run, the kind, the grammar label, the prompts that had a schema and the probe. */
export function providerLines(label: ProviderLabel): string[] {
  if (label.kind === 'anthropic') return [];
  return [
    `provider: local, grammar ${label.grammar === true ? 'on' : 'off'}`,
    ...(label.grammarPrompts !== undefined && label.grammarPrompts.length > 0 ? [`grammar prompts: ${label.grammarPrompts.join(', ')}`] : []),
    ...(label.thinking === 'off' ? ['thinking: off'] : []),
    ...(label.probe === undefined ? [] : [`schema probe: ${label.probe}`]),
  ];
}
