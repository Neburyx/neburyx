import { type AskSourceFolder } from '@neburyx/contracts';
import type { BuiltPatternCatalog } from '../patterns/index.js';
import { TEMPLATE_TOOL_LIST } from './tool-templates.js';

type ToolKind = 'intent' | 'template' | 'pattern' | 'view';

export interface Tool {
  readonly name: string;
  /** The plain-words label of an intent that has one: shown to the model beside the id, which a request still names. */
  readonly label?: string;
  readonly kind: ToolKind;
  /** The names of the values a request for the tool gives, exactly. */
  readonly parameters: readonly string[];
  /** False for an intent whose template can no longer run: it is listed, and a request for it is answered as unavailable. */
  readonly available: boolean;
}

export interface ToolRegistry {
  readonly tools: readonly Tool[];
  find(name: string): Tool | undefined;
}

export interface ToolRegistryInput {
  readonly source: AskSourceFolder | undefined;
  readonly patterns: BuiltPatternCatalog | undefined;
  /** Whether the view can be read again in this turn. */
  readonly viewReadable: boolean;
  readonly templateRunnable: (template: string) => boolean;
}

const VIEW_TOOL = 'view';
const PATTERN_ANCHOR_PARAMETER = 'anchor';

/**
 * The reads the model may ask for in one turn: each intent of the source's folder, each catalog template by its id, each saved pattern of the person (the system and built-in ones are offered with them) and the view. A name given twice keeps its first
 * owner, so a folder intent is never shadowed by a generated name. Nothing here writes: a tool is a name, its parameters and a kind, and what it reads is decided by the step that runs it.
 */
export function buildToolRegistry(input: ToolRegistryInput): ToolRegistry {
  const tools: Tool[] = [];
  const known = new Set<string>();
  const add = (tool: Tool): void => {
    if (known.has(tool.name)) return;
    known.add(tool.name);
    tools.push(tool);
  };
  for (const intent of input.source?.intents ?? []) {
    add({ name: intent.name, ...(intent.label === undefined ? {} : { label: intent.label }), kind: 'intent', parameters: intent.parameters, available: intent.kind === 'query' || input.templateRunnable(intent.template) });
  }
  if (input.source !== undefined) {
    for (const template of TEMPLATE_TOOL_LIST) add({ name: template.name, kind: 'template', parameters: template.parameters, available: input.templateRunnable(template.template) });
  }
  for (const [key, entry] of input.patterns?.catalog.entries ?? []) {
    add({ name: key, kind: 'pattern', parameters: entry.startingEntity === 'asked' ? [PATTERN_ANCHOR_PARAMETER] : [], available: true });
  }
  if (input.viewReadable) add({ name: VIEW_TOOL, kind: 'view', parameters: [], available: true });
  return { tools, find: (name) => tools.find((tool) => tool.name === name) };
}
