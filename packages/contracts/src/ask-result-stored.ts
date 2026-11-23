import { z } from 'zod';
import { ASK_ENTITY_TEXT_MAX_LENGTH, type AskRunResult } from './ask.js';
import { ASK_FOLDER_LIMITS, isParameterName } from './ask-folder.js';
import type { AskAnswer } from './ask-question.js';
import { PATHS_HOPS_MAX, PATHS_RESULTS_MAX } from './paths.js';
import { countSchema, edgeRefSchema, elementRefSchema, type Count, type GraphEdge, type GraphNode } from './graph.js';
import { TEMPLATE_RUN_NOTICE_CODES, templateRunNoticeSchema } from './template-run.js';

/** The bounds of the stored result of an Ask answer. Working limits of the thread, not taken from a source. */
export const ASK_RESULT_ROWS_MAX = 25;
export const ASK_RESULT_LINES_MAX = 12;
export const ASK_RESULT_REFS_MAX = 100;
export const ASK_RESULT_NOTICE_ENTRIES_MAX = 25;
export const ASK_RESULT_LABEL_MAX = 80;
export const ASK_RESULT_TEXT_MAX = 300;

/** The words of a count line that are the card's own and not a name of the mapping. */
export const ASK_RESULT_WORDS = { relationships: 'Relationships', entity: 'Entity', supports: 'Supports', paths: 'Paths', exact: 'Exact matches', related: 'Related records', evidence: 'Supporting relationships' } as const;

const frozenText = z.strictObject({ form: z.literal('frozen'), text: z.string().min(1).max(ASK_RESULT_TEXT_MAX) });
const elementItem = z.union([frozenText, z.strictObject({ form: z.literal('ref'), ref: elementRefSchema })]);
const rowItem = z.union([frozenText, z.strictObject({ form: z.literal('ref'), ref: z.union([elementRefSchema, edgeRefSchema]) })]);

const line = z.strictObject({ label: z.string().min(1).max(120), count: countSchema.optional(), shown: z.number().int().nonnegative().optional(), more: z.boolean().optional(), item: elementItem.optional() });
const step = z.strictObject({ relationshipType: z.string().min(1).max(200), from: elementItem, to: elementItem });
const path = z.strictObject({ hops: z.number().int().min(1).max(PATHS_HOPS_MAX), steps: z.array(step).min(1).max(PATHS_HOPS_MAX) });
const omitted = z.strictObject({ rows: z.number().int().nonnegative(), paths: z.number().int().nonnegative(), lines: z.number().int().nonnegative(), noticeEntries: z.number().int().nonnegative() });
const TEMPLATE_IDS = ['shared-attribute', 'linked-entities', 'entity', 'degree-preview', 'expand', 'derived-rule-run', 'derived-edge-support', 'search', 'shortest-paths', 'file-query', 'saved-pattern'] as const;

/**
 * The result card of an Ask answer as a thread keeps it: counts and references, never a value. A result written with the mask on holds the rows as the masked text the gate returned (`frozen`); one written with the mask off holds references, which the panel
 * reads again under the mask it has. The values are what the person typed, kept under the rule of the typed question.
 */
export const storedAskResultSchema = z
  .strictObject({
    kind: z.literal('ask-result'),
    templateId: z.enum(TEMPLATE_IDS),
    outcome: z.enum(['complete', 'partial']),
    label: z.string().min(1).max(ASK_RESULT_LABEL_MAX).optional(),
    values: z.array(z.strictObject({ name: z.string().refine(isParameterName, { message: 'a parameter name' }), text: z.string().min(1).max(ASK_ENTITY_TEXT_MAX_LENGTH) })).max(ASK_FOLDER_LIMITS.parameters),
    count: z.strictObject({ count: countSchema, noun: z.enum(['match', 'row']) }).optional(),
    listed: z.number().int().nonnegative().optional(),
    lines: z.array(line).max(ASK_RESULT_LINES_MAX),
    rows: z.array(rowItem).max(ASK_RESULT_ROWS_MAX),
    paths: z.array(path).max(PATHS_RESULTS_MAX),
    pathCut: z.strictObject({ capReached: z.boolean(), partial: z.boolean(), retained: z.number().int().positive().optional(), requested: z.number().int().positive().optional() }).optional(),
    notices: z.array(templateRunNoticeSchema).max(TEMPLATE_RUN_NOTICE_CODES.length),
    stop: z.strictObject({ estimate: countSchema, threshold: z.number().int().positive() }).optional(),
    omitted,
  })
  .refine((block) => distinctRefs(block) <= ASK_RESULT_REFS_MAX, { message: 'at most 100 references in one stored result', path: ['rows'] });

export type StoredAskResult = z.infer<typeof storedAskResultSchema>;

function distinctRefs(block: { readonly rows: readonly z.infer<typeof rowItem>[]; readonly lines: readonly z.infer<typeof line>[]; readonly paths: readonly z.infer<typeof path>[]; readonly notices: readonly z.infer<typeof templateRunNoticeSchema>[] }): number {
  const seen = new Set<string>();
  const add = (ref: unknown): void => void seen.add(JSON.stringify(ref));
  for (const row of block.rows) if (row.form === 'ref') add(row.ref);
  for (const each of block.lines) if (each.item?.form === 'ref') add(each.item.ref);
  for (const each of block.paths) for (const entry of each.steps) for (const end of [entry.from, entry.to]) if (end.form === 'ref') add(end.ref);
  for (const notice of block.notices) if (notice.code === 'supernodesSkipped') for (const ref of notice.entities) add(ref);
  return seen.size;
}

const titleOf = (nodes: readonly GraphNode[], ref: { readonly entityType: string; readonly stableId: string }): string => {
  const node = nodes.find((entry) => entry.ref.entityType === ref.entityType && entry.ref.stableId === ref.stableId);
  return node === undefined || node.display.title === '' ? ref.stableId : node.display.title;
};

const cut = (text: string): string => (text.length > ASK_RESULT_TEXT_MAX ? `${text.slice(0, ASK_RESULT_TEXT_MAX - 1)}…` : text);

/** The notices of a run, one for each distinct code in the order of the codes, the payloads merged without repeats and cut at the bound; how many entries were cut. */
function noticesOf(notices: readonly z.infer<typeof templateRunNoticeSchema>[], budget: { left: number }): { readonly kept: StoredAskResult['notices']; readonly cutEntries: number } {
  let cutEntries = 0;
  const kept: StoredAskResult['notices'] = [];
  for (const code of TEMPLATE_RUN_NOTICE_CODES) {
    const of = notices.filter((notice) => notice.code === code);
    if (of.length === 0) continue;
    if (code === 'windowNotApplied') {
      const names = [...new Set(of.flatMap((notice) => (notice.code === 'windowNotApplied' ? notice.relationshipTypes : [])))];
      cutEntries += Math.max(0, names.length - ASK_RESULT_NOTICE_ENTRIES_MAX);
      kept.push({ code, relationshipTypes: names.slice(0, ASK_RESULT_NOTICE_ENTRIES_MAX) });
    } else if (code === 'supernodesSkipped') {
      const unique = new Map(of.flatMap((notice) => (notice.code === 'supernodesSkipped' ? notice.entities : [])).map((ref) => [JSON.stringify(ref), ref] as const));
      const refs = [...unique.values()];
      const room = Math.max(0, Math.min(ASK_RESULT_NOTICE_ENTRIES_MAX, budget.left));
      budget.left -= Math.min(room, refs.length);
      cutEntries += refs.length - Math.min(room, refs.length);
      kept.push({ code, entities: refs.slice(0, room) });
    } else kept.push({ code } as StoredAskResult['notices'][number]);
  }
  return { kept, cutEntries };
}

interface Listed {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** The rows of a file query as the card draws them: each relationship, then each entity no relationship names; as text for a result written with the mask on, as references otherwise. */
function rowsOf(listed: Listed, maskOn: boolean): readonly z.infer<typeof rowItem>[] {
  const named = new Set(listed.edges.flatMap((edge) => [`${edge.from.entityType}\u0000${edge.from.stableId}`, `${edge.to.entityType}\u0000${edge.to.stableId}`]));
  const edges = listed.edges.map((edge) => (maskOn ? ({ form: 'frozen', text: cut(`${titleOf(listed.nodes, edge.from)} → ${edge.type} → ${titleOf(listed.nodes, edge.to)}`) } as const) : ({ form: 'ref', ref: edge.ref } as const)));
  const nodes = listed.nodes.filter((node) => !named.has(`${node.ref.entityType}\u0000${node.ref.stableId}`)).map((node) => (maskOn ? ({ form: 'frozen', text: cut(titleOf(listed.nodes, node.ref)) } as const) : ({ form: 'ref', ref: node.ref } as const)));
  return [...edges, ...nodes];
}

const countLine = (label: string, count: Count): z.infer<typeof line> => ({ label, count });

/**
 * The stored form of the result card of an Ask answer, or nothing when the answer is a refusal. A pure projection that runs before the schema validates it: a result over a bound is cut and says so in `omitted`, never refused. The budget of 100 references is
 * spent on the rows of a file query, then whole paths in the order the search gave them, then the references inside notices.
 */
export function storedAskResultOf(ask: AskAnswer, maskOn: boolean): StoredAskResult | undefined {
  if ('refused' in ask) return undefined;
  const { answered } = ask;
  const result: AskRunResult = answered.result;
  const budget = { left: ASK_RESULT_REFS_MAX };
  const base = {
    kind: 'ask-result' as const,
    templateId: result.templateId === 'derived-edge-support' ? ('derived-edge-support' as const) : (result.templateId as (typeof TEMPLATE_IDS)[number]),
    outcome: answered.outcome,
    ...(answered.label === undefined ? {} : { label: answered.label.slice(0, ASK_RESULT_LABEL_MAX) }),
    values: Object.entries(answered.entities).filter(([name]) => name !== 'pattern').map(([name, text]) => ({ name, text })),
  };
  const out: { -readonly [K in keyof StoredAskResult]: StoredAskResult[K] } = { ...base, lines: [], rows: [], paths: [], notices: [], omitted: { rows: 0, paths: 0, lines: 0, noticeEntries: 0 } };
  const noticed = (notices: readonly z.infer<typeof templateRunNoticeSchema>[]): void => {
    const made = noticesOf(notices, budget);
    out.notices = made.kept;
    out.omitted = { ...out.omitted, noticeEntries: made.cutEntries };
  };
  const heavy = (estimate: Count, threshold: number): void => void (out.stop = { estimate, threshold });
  switch (result.templateId) {
    case 'shared-attribute':
    case 'linked-entities':
    case 'saved-pattern': {
      const run = result.result;
      if (run.status === 'heavy') heavy(run.estimate, run.threshold);
      else {
        out.count = { count: run.count, noun: 'match' };
        out.listed = 'matches' in run ? run.matches.length : run.matchIds.length;
      }
      noticed(run.notices);
      break;
    }
    case 'file-query': {
      const rows = rowsOf(result.result, maskOn);
      out.count = { count: result.result.count, noun: 'row' };
      out.listed = rows.length;
      out.rows = rows.slice(0, Math.min(ASK_RESULT_ROWS_MAX, budget.left));
      budget.left -= out.rows.filter((row) => row.form === 'ref').length;
      out.omitted = { ...out.omitted, rows: rows.length - out.rows.length };
      noticed(result.result.notices);
      break;
    }
    case 'entity':
      out.lines = [{ label: ASK_RESULT_WORDS.entity, item: maskOn ? { form: 'frozen', text: cut(titleOf([result.result], result.result.ref)) } : { form: 'ref', ref: result.result.ref } }];
      break;
    case 'degree-preview': {
      const lines = [countLine(ASK_RESULT_WORDS.relationships, result.result.total), ...result.result.byType.map((entry) => countLine(`${entry.relationshipType} · ${entry.direction === 'out' ? 'outgoing' : 'incoming'}`, entry.count))];
      out.lines = lines.slice(0, ASK_RESULT_LINES_MAX);
      out.omitted = { ...out.omitted, lines: lines.length - out.lines.length };
      break;
    }
    case 'expand': {
      const lines = result.result.pages.map((page) => ({ label: page.neighborType, count: page.matchingTotal, shown: page.returned, more: page.hasMore }));
      out.lines = lines.slice(0, ASK_RESULT_LINES_MAX);
      out.omitted = { ...out.omitted, lines: lines.length - out.lines.length };
      break;
    }
    case 'derived-rule-run': {
      const lines = result.result.results.map((entry) => countLine(entry.ruleId, entry.count));
      out.lines = lines.slice(0, ASK_RESULT_LINES_MAX);
      out.omitted = { ...out.omitted, lines: lines.length - out.lines.length };
      break;
    }
    case 'derived-edge-support':
      out.lines = [countLine(ASK_RESULT_WORDS.supports, result.result.supports.count)];
      break;
    case 'search':
      out.lines = [countLine(ASK_RESULT_WORDS.exact, result.result.counts.exact), countLine(ASK_RESULT_WORDS.related, result.result.related.count), countLine(ASK_RESULT_WORDS.evidence, result.result.evidence.count)];
      break;
    case 'shortest-paths': {
      const run = result.result;
      if (run.status === 'heavy') {
        heavy(run.estimate, run.threshold);
        break;
      }
      const wholePaths = [];
      for (const each of run.paths.slice(0, PATHS_RESULTS_MAX)) {
        const ends = each.steps.flatMap((entry) => [entry.from, entry.to]);
        const distinct = new Set(ends.map((end) => JSON.stringify(end))).size;
        const spend = maskOn ? 0 : distinct;
        if (each.steps.length > PATHS_HOPS_MAX || spend > budget.left) continue;
        budget.left -= spend;
        wholePaths.push({ hops: each.hops, steps: each.steps.map((entry) => ({ relationshipType: entry.relationshipType, from: maskOn ? ({ form: 'frozen', text: cut(titleOf(run.nodes, entry.from)) } as const) : ({ form: 'ref', ref: entry.from } as const), to: maskOn ? ({ form: 'frozen', text: cut(titleOf(run.nodes, entry.to)) } as const) : ({ form: 'ref', ref: entry.to } as const) })) });
      }
      out.paths = wholePaths;
      out.omitted = { ...out.omitted, paths: run.paths.length - wholePaths.length };
      out.lines = [{ label: ASK_RESULT_WORDS.paths, shown: run.paths.length }];
      out.pathCut = { capReached: run.capReached, partial: run.partial, ...(run.retained === undefined ? {} : { retained: run.retained }), ...(run.requested === undefined ? {} : { requested: run.requested }) };
      break;
    }
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
  return out;
}
