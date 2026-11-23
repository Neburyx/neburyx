import { z } from 'zod';
import { ASK_ENTITY_TEXT_MAX_LENGTH, type AskRunResult } from './ask.js';
import { ASK_FOLDER_LIMITS, ASK_SAVED_PATTERN_INTENT, isParameterName } from './ask-folder.js';
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

export const ASK_RESULT_NAME_MAX = 120;
export const ASK_RESULT_TYPE_MAX = 200;

const frozenText = z.strictObject({ form: z.literal('frozen'), text: z.string().min(1).max(ASK_RESULT_TEXT_MAX) });
/** What a read sends in place of a frozen text it may not send: the sensitivity of the mapping is not known to be the one it was written under. */
const withheldText = z.strictObject({ form: z.literal('withheld') });
const elementRef = z.strictObject({ form: z.literal('ref'), ref: elementRefSchema });
const anyRef = z.strictObject({ form: z.literal('ref'), ref: z.union([elementRefSchema, edgeRefSchema]) });

const lineOf = <E extends z.ZodType>(elementItem: E) => z.strictObject({ label: z.string().min(1).max(ASK_RESULT_NAME_MAX), count: countSchema.optional(), shown: z.number().int().nonnegative().optional(), more: z.boolean().optional(), item: elementItem.optional() });
const pathOf = <E extends z.ZodType>(elementItem: E) => z.strictObject({ hops: z.number().int().min(1).max(PATHS_HOPS_MAX), steps: z.array(z.strictObject({ relationshipType: z.string().min(1).max(ASK_RESULT_TYPE_MAX), from: elementItem, to: elementItem })).min(1).max(PATHS_HOPS_MAX) });

const storedElement = z.union([frozenText, elementRef]);
const storedParts = { elementItem: storedElement, rowItem: z.union([frozenText, anyRef]), line: lineOf(storedElement), path: pathOf(storedElement) };
const readElement = z.union([frozenText, elementRef, withheldText]);
const readParts = { elementItem: readElement, rowItem: z.union([frozenText, anyRef, withheldText]), line: lineOf(readElement), path: pathOf(readElement) };
const TEMPLATE_IDS = ['shared-attribute', 'linked-entities', 'entity', 'degree-preview', 'expand', 'derived-rule-run', 'derived-edge-support', 'search', 'shortest-paths', 'file-query', 'saved-pattern'] as const;
const omitted = z.strictObject({ rows: z.number().int().nonnegative(), paths: z.number().int().nonnegative(), lines: z.number().int().nonnegative(), noticeEntries: z.number().int().nonnegative() });

const commonShape = {
  kind: z.literal('ask-result'),
  templateId: z.enum(TEMPLATE_IDS),
  outcome: z.enum(['complete', 'partial']),
  label: z.string().min(1).max(ASK_RESULT_LABEL_MAX).optional(),
  values: z.array(z.strictObject({ name: z.string().refine(isParameterName, { message: 'a parameter name' }), text: z.string().min(1).max(ASK_ENTITY_TEXT_MAX_LENGTH) })).max(ASK_FOLDER_LIMITS.parameters),
  count: z.strictObject({ count: countSchema, noun: z.enum(['match', 'row']) }).optional(),
  listed: z.number().int().nonnegative().optional(),
  pathCut: z.strictObject({ capReached: z.boolean(), partial: z.boolean(), retained: z.number().int().positive().optional(), requested: z.number().int().positive().optional() }).optional(),
  notices: z.array(templateRunNoticeSchema).max(TEMPLATE_RUN_NOTICE_CODES.length),
  /** For a notice whose payload was cut, how many entries the source gave: the card says it kept some of them. */
  noticeTotals: z.array(z.strictObject({ code: z.enum(TEMPLATE_RUN_NOTICE_CODES), total: z.number().int().positive() })).max(TEMPLATE_RUN_NOTICE_CODES.length),
  stop: z.strictObject({ estimate: countSchema, threshold: z.number().int().positive() }).optional(),
  omitted,
};

/**
 * The result card of an Ask answer as a thread keeps it: counts and references, never a value. A result written with the mask on holds the rows as the masked text the gate returned (`frozen`); one written with the mask off holds references, which the panel
 * reads again under the mask it has. The values are what the person typed, kept under the rule of the typed question.
 */
export const storedAskResultSchema = z
  .strictObject({ ...commonShape, lines: z.array(storedParts.line).max(ASK_RESULT_LINES_MAX), rows: z.array(storedParts.rowItem).max(ASK_RESULT_ROWS_MAX), paths: z.array(storedParts.path).max(PATHS_RESULTS_MAX) })
  .refine((block) => distinctRefs(block) <= ASK_RESULT_REFS_MAX, { message: 'at most 100 references in one stored result', path: ['rows'] });
export type StoredAskResult = z.infer<typeof storedAskResultSchema>;

/** The block as the thread read sends it: a frozen text that a read may not send is `withheld`. */
export const readAskResultSchema = z.strictObject({ ...commonShape, lines: z.array(readParts.line).max(ASK_RESULT_LINES_MAX), rows: z.array(readParts.rowItem).max(ASK_RESULT_ROWS_MAX), paths: z.array(readParts.path).max(PATHS_RESULTS_MAX) });
export type ReadAskResult = z.infer<typeof readAskResultSchema>;

type StoredRow = z.infer<typeof storedParts.rowItem>;
type StoredLine = z.infer<typeof storedParts.line>;
type StoredPath = z.infer<typeof storedParts.path>;
type StoredEnd = z.infer<typeof storedParts.elementItem>;

function distinctRefs(block: { readonly rows: readonly StoredRow[]; readonly lines: readonly StoredLine[]; readonly paths: readonly StoredPath[]; readonly notices: readonly z.infer<typeof templateRunNoticeSchema>[] }): number {
  const seen = new Set<string>();
  const add = (ref: unknown): void => void seen.add(JSON.stringify(ref));
  for (const row of block.rows) if (row.form === 'ref') add(row.ref);
  for (const each of block.lines) if (each.item?.form === 'ref') add(each.item.ref);
  for (const each of block.paths) for (const entry of each.steps) for (const end of [entry.from, entry.to]) if (end.form === 'ref') add(end.ref);
  for (const notice of block.notices) if (notice.code === 'supernodesSkipped') for (const ref of notice.entities) add(ref);
  return seen.size;
}

/** A text cut to at most `max` UTF-16 units at the edge of a code point, with an ellipsis when it was cut: never half of a surrogate pair. */
export function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const character of text) {
    if (out.length + character.length > max - 1) break;
    out += character;
  }
  return `${out}…`;
}

const titleOf = (nodes: readonly GraphNode[], ref: { readonly entityType: string; readonly stableId: string }): string => {
  const node = nodes.find((entry) => entry.ref.entityType === ref.entityType && entry.ref.stableId === ref.stableId);
  return node === undefined || node.display.title === '' ? ref.stableId : node.display.title;
};

const cut = (text: string): string => cutText(text, ASK_RESULT_TEXT_MAX);
const refKey = (ref: unknown): string => JSON.stringify(ref);

interface Budget {
  /** The references already charged: a reference two parts of the block share is charged once. */
  readonly charged: Set<string>;
}

const spend = (budget: Budget, refs: readonly unknown[]): number => refs.filter((ref) => !budget.charged.has(refKey(ref))).length;
const charge = (budget: Budget, refs: readonly unknown[]): void => refs.forEach((ref) => budget.charged.add(refKey(ref)));
const room = (budget: Budget): number => ASK_RESULT_REFS_MAX - budget.charged.size;

/**
 * The notices of a run, one for each distinct code in the order of the codes, the payloads merged without repeats and cut at the bound or at what is left of the budget; how many entries were cut, and for each code that was cut how many the source gave.
 */
function noticesOf(notices: readonly z.infer<typeof templateRunNoticeSchema>[], budget: Budget): { readonly kept: StoredAskResult['notices']; readonly cutEntries: number; readonly totals: StoredAskResult['noticeTotals'] } {
  let cutEntries = 0;
  const totals: StoredAskResult['noticeTotals'][number][] = [];
  const kept: StoredAskResult['notices'] = [];
  for (const code of TEMPLATE_RUN_NOTICE_CODES) {
    const of = notices.filter((notice) => notice.code === code);
    if (of.length === 0) continue;
    if (code === 'windowNotApplied') {
      const names = [...new Set(of.flatMap((notice) => (notice.code === 'windowNotApplied' ? notice.relationshipTypes : [])))];
      const keep = names.slice(0, ASK_RESULT_NOTICE_ENTRIES_MAX);
      if (keep.length < names.length) totals.push({ code, total: names.length });
      cutEntries += names.length - keep.length;
      kept.push({ code, relationshipTypes: keep });
    } else if (code === 'supernodesSkipped') {
      const refs = [...new Map(of.flatMap((notice) => (notice.code === 'supernodesSkipped' ? notice.entities : [])).map((ref) => [refKey(ref), ref] as const)).values()];
      const keep: typeof refs = [];
      for (const ref of refs) {
        if (keep.length >= ASK_RESULT_NOTICE_ENTRIES_MAX || (spend(budget, [ref]) > 0 && room(budget) < 1)) continue;
        keep.push(ref);
        charge(budget, [ref]);
      }
      if (keep.length < refs.length) totals.push({ code, total: refs.length });
      cutEntries += refs.length - keep.length;
      kept.push({ code, entities: keep });
    } else kept.push({ code } as StoredAskResult['notices'][number]);
  }
  return { kept, cutEntries, totals };
}

interface Listed {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** The rows of a file query as the card draws them: each relationship, then each entity no relationship names; as text for a result written with the mask on, as references otherwise. */
function rowsOf(listed: Listed, maskOn: boolean): readonly StoredRow[] {
  const named = new Set(listed.edges.flatMap((edge) => [`${edge.from.entityType}\u0000${edge.from.stableId}`, `${edge.to.entityType}\u0000${edge.to.stableId}`]));
  const edges = listed.edges.map((edge) => (maskOn ? ({ form: 'frozen', text: cut(`${titleOf(listed.nodes, edge.from)} → ${edge.type} → ${titleOf(listed.nodes, edge.to)}`) } as const) : ({ form: 'ref', ref: edge.ref } as const)));
  const nodes = listed.nodes.filter((node) => !named.has(`${node.ref.entityType}\u0000${node.ref.stableId}`)).map((node) => (maskOn ? ({ form: 'frozen', text: cut(titleOf(listed.nodes, node.ref)) } as const) : ({ form: 'ref', ref: node.ref } as const)));
  return [...edges, ...nodes];
}

const countLine = (label: string, count: Count): StoredLine => ({ label: cutText(label, ASK_RESULT_NAME_MAX), count });

/**
 * The stored form of the result card of an Ask answer, or nothing when the answer is a refusal. A pure projection that runs before the schema validates it: a result over a bound is cut and says so in `omitted`, never refused, and a name or a text over its
 * bound is cut at a character boundary. The budget of 100 references is spent on the rows of a file query, then whole paths in the order the search gave them, then the references inside notices, a reference two of them share being charged once.
 */
export function storedAskResultOf(ask: AskAnswer, maskOn: boolean): StoredAskResult | undefined {
  if ('refused' in ask) return undefined;
  const { answered } = ask;
  const result: AskRunResult = answered.result;
  const budget: Budget = { charged: new Set() };
  // the pattern input of a saved pattern names it by an internal id, which is no value of the question; any other intent's input of that name is a value
  const typed = Object.entries(answered.entities).filter(([name]) => answered.intent !== ASK_SAVED_PATTERN_INTENT || name !== 'pattern');
  const out: { -readonly [K in keyof StoredAskResult]: StoredAskResult[K] } = {
    kind: 'ask-result',
    templateId: result.templateId as (typeof TEMPLATE_IDS)[number],
    outcome: answered.outcome,
    ...(answered.label === undefined ? {} : { label: cutText(answered.label, ASK_RESULT_LABEL_MAX) }),
    values: typed.map(([name, text]) => ({ name, text })),
    lines: [],
    rows: [],
    paths: [],
    notices: [],
    noticeTotals: [],
    omitted: { rows: 0, paths: 0, lines: 0, noticeEntries: 0 },
  };
  const noticed = (notices: readonly z.infer<typeof templateRunNoticeSchema>[]): void => {
    const made = noticesOf(notices, budget);
    out.notices = made.kept;
    out.noticeTotals = made.totals;
    out.omitted = { ...out.omitted, noticeEntries: made.cutEntries };
  };
  const lined = (lines: readonly StoredLine[]): void => {
    out.lines = lines.slice(0, ASK_RESULT_LINES_MAX);
    out.omitted = { ...out.omitted, lines: lines.length - out.lines.length };
  };
  switch (result.templateId) {
    case 'shared-attribute':
    case 'linked-entities':
    case 'saved-pattern': {
      const run = result.result;
      if (run.status === 'heavy') out.stop = { estimate: run.estimate, threshold: run.threshold };
      else {
        out.count = { count: run.count, noun: 'match' };
        out.listed = 'matches' in run ? run.matches.length : run.matchIds.length;
      }
      noticed(run.notices);
      break;
    }
    case 'file-query': {
      const rows = rowsOf(result.result, maskOn);
      const kept: StoredRow[] = [];
      for (const row of rows) {
        if (kept.length >= ASK_RESULT_ROWS_MAX) break;
        if (row.form === 'ref') {
          if (spend(budget, [row.ref]) > 0 && room(budget) < 1) break;
          charge(budget, [row.ref]);
        }
        kept.push(row);
      }
      out.count = { count: result.result.count, noun: 'row' };
      out.listed = rows.length;
      out.rows = kept;
      out.omitted = { ...out.omitted, rows: rows.length - kept.length };
      noticed(result.result.notices);
      break;
    }
    case 'entity': {
      const item: StoredEnd = maskOn ? { form: 'frozen', text: cut(titleOf([result.result], result.result.ref)) } : { form: 'ref', ref: result.result.ref };
      if (item.form === 'ref') charge(budget, [item.ref]);
      out.lines = [{ label: ASK_RESULT_WORDS.entity, item }];
      break;
    }
    case 'degree-preview':
      lined([countLine(ASK_RESULT_WORDS.relationships, result.result.total), ...result.result.byType.map((entry) => countLine(`${entry.relationshipType} · ${entry.direction === 'out' ? 'outgoing' : 'incoming'}`, entry.count))]);
      break;
    case 'expand':
      lined(result.result.pages.map((page) => ({ label: cutText(page.neighborType, ASK_RESULT_NAME_MAX), count: page.matchingTotal, shown: page.returned, more: page.hasMore })));
      break;
    case 'derived-rule-run':
      lined(result.result.results.map((entry) => countLine(entry.ruleId, entry.count)));
      break;
    case 'derived-edge-support':
      out.lines = [countLine(ASK_RESULT_WORDS.supports, result.result.supports.count)];
      break;
    case 'search':
      out.lines = [countLine(ASK_RESULT_WORDS.exact, result.result.counts.exact), countLine(ASK_RESULT_WORDS.related, result.result.related.count), countLine(ASK_RESULT_WORDS.evidence, result.result.evidence.count)];
      break;
    case 'shortest-paths': {
      const run = result.result;
      if (run.status === 'heavy') {
        out.stop = { estimate: run.estimate, threshold: run.threshold };
        break;
      }
      const whole: StoredPath[] = [];
      for (const each of run.paths.slice(0, PATHS_RESULTS_MAX)) {
        const ends = each.steps.flatMap((entry) => [entry.from, entry.to]);
        const needed = maskOn ? 0 : spend(budget, [...new Map(ends.map((end) => [refKey(end), end] as const)).values()]);
        if (each.steps.length > PATHS_HOPS_MAX || needed > room(budget)) continue;
        if (!maskOn) charge(budget, ends);
        whole.push({
          hops: each.hops,
          steps: each.steps.map((entry) => ({ relationshipType: cutText(entry.relationshipType, ASK_RESULT_TYPE_MAX), from: maskOn ? { form: 'frozen', text: cut(titleOf(run.nodes, entry.from)) } : { form: 'ref', ref: entry.from }, to: maskOn ? { form: 'frozen', text: cut(titleOf(run.nodes, entry.to)) } : { form: 'ref', ref: entry.to } })),
        });
      }
      out.paths = whole;
      out.omitted = { ...out.omitted, paths: run.paths.length - whole.length };
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
