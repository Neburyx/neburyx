import type { AskPlan } from '@neburyx/contracts';
import { templateName } from './plan-copy.js';

export type TemplatePlan = Extract<AskPlan, { kind: 'plan' }>;

export interface PlanLine {
  readonly label: string;
  readonly value: string;
}

export interface PlanView {
  readonly name: string;
  readonly id: string;
  readonly lines: readonly PlanLine[];
}

export interface Names {
  /** The display name the mapping gives an entity type, or the type when it gives none. */
  readonly entityType: (type: string) => string;
}

type Anchor = { readonly entityType: string; readonly stableId: string };
type Window = { readonly days: number } | { readonly from: string; readonly to: string };

const DIRECTIONS: Readonly<Record<string, string>> = { out: 'Outgoing', in: 'Incoming', both: 'Both directions' };

export const windowText = (window: Window): string => ('days' in window ? `${window.days} ${window.days === 1 ? 'day' : 'days'}` : `${window.from} to ${window.to}`);

const list = (values: readonly string[]): string => values.join(', ');
const anchorText = (anchor: Anchor, names: Names): string => `${names.entityType(anchor.entityType)} · ${anchor.stableId}`;

/** A value of a plan in words, whatever it is: used for a template the card has no words for, so it shows its parameters as plain labelled values. */
function plain(value: unknown): string {
  if (Array.isArray(value)) return value.map(plain).join(', ');
  if (typeof value === 'object' && value !== null) return Object.entries(value).map(([key, inner]) => `${key} ${plain(inner)}`).join(', ');
  return String(value);
}

/** The template and its typed parameters in words, in the order a person reads them; nothing that is not a typed parameter of the plan. */
export function planView(plan: TemplatePlan, names: Names): PlanView {
  const lines: PlanLine[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined) lines.push({ label, value });
  };
  const params = plan.params as Record<string, unknown>;
  switch (plan.templateId) {
    case 'shared-attribute':
      add('Anchor', anchorText(plan.params.ref, names));
      add('Attribute', plan.params.attributeType === undefined ? undefined : names.entityType(plan.params.attributeType));
      add('Through', plan.params.via);
      add('Window', plan.params.window === undefined ? undefined : windowText(plan.params.window));
      add('At least shared', plan.params.minShared === undefined ? undefined : String(plan.params.minShared));
      add('Limit', plan.params.limit === undefined ? undefined : String(plan.params.limit));
      break;
    case 'linked-entities':
      add('Anchor', anchorText(plan.params.ref, names));
      add('Target', plan.params.targetType === undefined ? undefined : names.entityType(plan.params.targetType));
      add('Through', plan.params.via === undefined ? undefined : list(plan.params.via));
      add('Direction', plan.params.direction === undefined ? undefined : DIRECTIONS[plan.params.direction]);
      add('Steps', plan.params.maxHops === undefined ? undefined : String(plan.params.maxHops));
      add('Window', plan.params.window === undefined ? undefined : windowText(plan.params.window));
      add('Limit', plan.params.limit === undefined ? undefined : String(plan.params.limit));
      break;
    case 'entity':
    case 'degree-preview':
      add('Entity', anchorText(plan.params.ref, names));
      break;
    case 'expand':
      add('Anchor', anchorText(plan.params.ref, names));
      add('Neighbors', list(plan.params.neighborTypes.map((type) => names.entityType(type))));
      add('Relationships', plan.params.relTypes === undefined ? undefined : list(plan.params.relTypes));
      add('Direction', plan.params.direction === undefined ? undefined : DIRECTIONS[plan.params.direction]);
      add('Order', plan.params.sort === undefined ? undefined : 'Newest first');
      add('Window', plan.params.window === undefined ? undefined : windowText(plan.params.window));
      add('Limit', plan.params.limit === undefined ? undefined : String(plan.params.limit));
      break;
    case 'derived-rule-run':
      add('Anchor', anchorText(plan.params.ref, names));
      add('Rule', plan.params.ruleId);
      break;
    case 'derived-edge-support':
      add('Rule', plan.params.ruleId);
      add('From', anchorText(plan.params.ends[0], names));
      add('To', anchorText(plan.params.ends[1], names));
      break;
    case 'search':
      add('Types', list(plan.params.entityTypes.map((type) => names.entityType(type))));
      add('Text', `“${plan.params.text}”`);
      break;
    default:
      for (const [key, value] of Object.entries(params)) add(key, plain(value));
  }
  return { name: templateName(plan.templateId), id: plan.templateId, lines };
}
