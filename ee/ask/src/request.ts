import type { DataClass, GraphProperty } from '@neburyx/contracts';
import type { PropertyRules, TypeKind } from './rules.js';
import type { ModelRequest } from './provider.js';

export interface ContextElement {
  readonly kind: TypeKind;
  readonly type: string;
  readonly placeholder: string;
  readonly properties: readonly GraphProperty[];
}

export interface BuiltRequest {
  readonly request: ModelRequest;
  readonly sentProperties: readonly string[];
  readonly sentPii: readonly string[];
}

export interface RequestBuilder {
  readonly ask: (input: { readonly question: string; readonly catalog: string }) => BuiltRequest;
  readonly summary: (input: { readonly elements: readonly ContextElement[] }) => BuiltRequest;
  readonly assistant: (input: { readonly message: string; readonly elements: readonly ContextElement[] }) => BuiltRequest;
}

const SENDABLE_CLASSES: ReadonlySet<DataClass> = new Set(['text', 'number', 'boolean', 'date', 'dateTime', 'localDateTime', 'time', 'localTime', 'duration']);
const LINE_BREAKS = /\r\n|[\r\n\v\f\u0085\u2028\u2029]/g;

function textOf(value: unknown): string | undefined {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value).replace(LINE_BREAKS, ' ') : undefined;
}

interface BuiltView {
  readonly text: string;
  readonly sent: readonly string[];
  readonly sentPii: readonly string[];
}

function viewOf(elements: readonly ContextElement[], rules: PropertyRules): BuiltView {
  const sent = new Set<string>();
  const sentPii = new Set<string>();
  const blocks = elements.map((element) => {
    const lines = [`${element.placeholder} [${element.type}]`];
    for (const property of element.properties) {
      if (property.masked || !SENDABLE_CLASSES.has(property.dataClass) || !rules.isSendable(element.kind, element.type, property.key)) continue;
      const pii = rules.isPii(element.kind, element.type, property.key);
      if (pii && !rules.piiOverride) continue;
      const text = textOf(property.value);
      if (text === undefined) continue;
      lines.push(`${property.key}: ${text}`);
      const name = `${element.type}.${property.key}`;
      sent.add(name);
      if (pii) sentPii.add(name);
    }
    return lines.join('\n');
  });
  return { text: blocks.join('\n\n'), sent: [...sent], sentPii: [...sentPii] };
}

const noProperties = (request: ModelRequest): BuiltRequest => ({ request, sentProperties: [], sentPii: [] });

/** The one place that turns what the gate returned into a request: a property goes in only when the rules allow it, after the gate has masked what it masks. */
export function createRequestBuilder(rules: PropertyRules): RequestBuilder {
  return {
    ask: ({ question, catalog }) => noProperties({ promptId: 'ask.plan', parameters: { question, catalog } }),
    summary: ({ elements }) => {
      const view = viewOf(elements, rules);
      return { request: { promptId: 'summary.view', parameters: { view: view.text } }, sentProperties: view.sent, sentPii: view.sentPii };
    },
    assistant: ({ message, elements }) => {
      const view = viewOf(elements, rules);
      return { request: { promptId: 'assistant.route', parameters: { message, view: view.text } }, sentProperties: view.sent, sentPii: view.sentPii };
    },
  };
}

export function piiPropertiesSentOf(built: BuiltRequest): readonly string[] {
  return built.sentPii;
}
