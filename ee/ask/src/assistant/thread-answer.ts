import type { AssistantThreadTurnWrite, AssistantTurnAnswer, StoredAnswer } from '@neburyx/contracts';
import { SENSITIVE_TITLE_KEY, THREAD_SEGMENTS_MAX, storedAskResultOf, type AskRunResult, type ElementRef } from '@neburyx/contracts';
import { buildSummary } from '../summary/index.js';
import { classifyItem, type Classified, type ClassifyContext } from './sensitive-items.js';

type Cite = AssistantThreadTurnWrite['citationRefs'][number];
type Sentence = { readonly text: string; readonly cites: readonly string[] };
type Citation = { readonly key: string; readonly kind: string; readonly ref?: Cite };
type Block = StoredAnswer['blocks'][number];
type TextItem = { readonly form: 'frozen' | 'unbound'; readonly text: string };
type Item = TextItem | { form: 'bound'; segments: ({ literal: string } | { element: Cite; property: string })[] };

/** The element a key of an answer stands for, when the key is one of an element or a relationship (not a read, not a meaning); the references the thread already keeps. */
const refsOf = (citations: readonly Citation[]): Map<string, Cite> => new Map(citations.flatMap((citation) => (citation.ref === undefined || citation.kind === 'read' || citation.kind === 'description' ? [] : [[citation.key, citation.ref] as const])));

/** The text an item was made from, by the item the conversion made: what a binding is checked against, since a bound item keeps none of its values. */
const ORIGINAL = new WeakMap<object, string>();
/** For an item of an Ask summary bound to the titles of the elements it cites: the segments and the text the summary was built again with, that the write check compares the stored item with. */
const ASK_EXPECTED = new WeakMap<object, string>();

/** How an item of an answer written with the mask off is classified, by its text and the keys of the elements it cites; absent, every such item is `unbound`. */
export type ClassifyItem = (text: string, cited: readonly string[]) => Classified;

/**
 * The stored form of an item: a turn written with the mask on is stored as it was shown, `frozen`; one written with it off as its classification says: `frozen`, `bound` (literal pieces and, in place of each sensitive value, the element reference
 * and the property key; the value itself is never kept) or `unbound` (as written, whole). A text longer than its bound, an element with no reference and an item that would need more than `THREAD_SEGMENTS_MAX` segments are `unbound`: the first is
 * then refused by the schema, so that the bounds apply to the text as written and never to what the conversion leaves.
 */
function itemOf(text: string, cited: readonly string[], refs: ReadonlyMap<string, Cite>, maskOn: boolean, max: number, classify: ClassifyItem | undefined): Item {
  if (maskOn) return { form: 'frozen', text };
  const unbound: Item = { form: 'unbound', text };
  if (text.length > max || classify === undefined) return unbound;
  const classified = classify(text, cited);
  if (classified.form === 'frozen') return { form: 'frozen', text };
  if (classified.form === 'unbound') return unbound;
  const written = text.normalize('NFC');
  const segments: ({ literal: string } | { element: Cite; property: string })[] = [];
  let at = 0;
  for (const span of classified.spans) {
    const element = refs.get(span.element);
    if (element === undefined) return unbound;
    if (span.start > at) segments.push({ literal: written.slice(at, span.start) });
    segments.push({ element, property: span.property });
    at = span.end;
  }
  if (at < written.length) segments.push({ literal: written.slice(at) });
  const item: Item = segments.length > THREAD_SEGMENTS_MAX || segments.length === 0 ? unbound : { form: 'bound', segments };
  ORIGINAL.set(item, text);
  return item;
}

/**
 * The stored form of an answer that a turn ended with, or nothing for an answer that has no stored form yet. The fixed sentences of the server are kept as they are written, `frozen`, in either case. Only the answers that carry blocks (sentences and tables) or a refusal have a form here.
 */
export interface StoredAnswerResult {
  readonly answer: StoredAnswer;
  /** The key an element reference had in the answer, for checking a binding against the provenance of the turn. */
  readonly keyOf: (ref: Cite) => string | undefined;
}

const withMade = (result: StoredAnswerResult, made: Pick<StoredAnswer, 'model' | 'coverage'>): StoredAnswerResult => ({ ...result, answer: { ...made, ...result.answer } });

/** The stored form of Ask's own answer inside a turn: its refusal as a refusal block, and its cited summary as a block of sentences, written with the mask on as frozen and otherwise as written (unbound, since nothing was sent to a model to classify them against). */
/** The marker, the padding and the first identifier of the private-use characters that stand for a title while a summary is built again: one identifier for each element, so that the text of a sentence says which element each title is, whatever the titles are. */
const MARK = 0xe000;
const PAD = 0xe001;
const ID0 = 0xe100;
const ID_MAX = 0xefff;
/** The templates whose summary names the anchor of the run, and how many elements are tried as that anchor at most. */
const ANCHORED_TEMPLATES: ReadonlySet<string> = new Set(['shared-attribute', 'linked-entities', 'saved-pattern']);
const ANCHOR_TRIES_MAX = 50;
const SENTINEL = /\ue000[\ue100-\uefff]\ue001*|[\ue100-\uefff]/gu;

interface Probe {
  /** The result with the display title of every element replaced by a sentinel of the same length. */
  readonly result: AskRunResult;
  readonly owners: ReadonlyMap<number, ElementRef>;
  /** What the summary writes for the element: its title, or its identifier when the title is empty. */
  readonly written: ReadonlyMap<number, string>;
  /** Whether what is written is a title that the gate masks. */
  readonly bindable: ReadonlySet<number>;
}

const isElementRef = (value: unknown): value is { sourceId: string; entityType: string; stableId: string } =>
  typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>)['sourceId'] === 'string' && typeof (value as Record<string, unknown>)['entityType'] === 'string' && typeof (value as Record<string, unknown>)['stableId'] === 'string';

/** A sentinel as long as the text it stands for, in code points, so that every choice of the summary that rests on a length is made as it was. */
function sentinelOf(index: number, length: number): string {
  const id = String.fromCodePoint(ID0 + index);
  if (length <= 1) return id;
  return `${String.fromCodePoint(MARK)}${id}${String.fromCodePoint(PAD).repeat(length - 2)}`;
}

/** The result with the title of each element it holds replaced by a sentinel, or nothing when that cannot be done without a doubt (too many elements, or a private-use character in a title). */
function probeOf(result: AskRunResult): Probe | undefined {
  const owners = new Map<number, ElementRef>();
  const written = new Map<number, string>();
  const bindable = new Set<number>();
  let doubtful = false;
  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object' || value === null) return value;
    const entries = Object.entries(value as Record<string, unknown>);
    const ref = (value as Record<string, unknown>)['ref'];
    const display = (value as Record<string, unknown>)['display'];
    const shownTitle = typeof display === 'object' && display !== null ? (display as Record<string, unknown>)['title'] : undefined;
    const plainTitle = (value as Record<string, unknown>)['title'];
    // an element is held with its title in `display` (a node) or beside its reference (an end of a derived relationship)
    const isNode = isElementRef(ref) && typeof shownTitle === 'string';
    const isEnd = isElementRef(ref) && typeof plainTitle === 'string' && !isNode;
    const mapped = Object.fromEntries(entries.map(([key, entry]) => [key, (key === 'display' && isNode) || (key === 'title' && isEnd) ? entry : walk(entry)]));
    if (!isNode && !isEnd) return mapped;
    const title = isNode ? (shownTitle as string) : (plainTitle as string);
    const shown = title.trim() === '' ? ref.stableId : title;
    const index = owners.size;
    if (ID0 + index > ID_MAX || /[\ue000-\uefff]/u.test(shown)) doubtful = true;
    owners.set(index, ref);
    written.set(index, shown);
    if (title.trim() !== '') bindable.add(index);
    return isNode ? { ...mapped, display: { ...(display as object), title: sentinelOf(index, [...shown].length) } } : { ...mapped, title: sentinelOf(index, [...shown].length) };
  };
  const probe = walk(result) as AskRunResult;
  return doubtful ? undefined : { result: probe, owners, written, bindable };
}

/** A sentence of the build with sentinels, with each sentinel replaced by what the summary writes for its element. */
function withTitles(text: string, probe: Probe): string {
  return text.replace(SENTINEL, (found) => {
    const id = [...found].find((character) => (character.codePointAt(0) ?? 0) >= ID0) as string;
    return probe.written.get((id.codePointAt(0) ?? 0) - ID0) ?? found;
  });
}

type Segment = { literal: string } | { element: Cite; property: string };

/**
 * One sentence of the cited summary of an Ask answer, written with the mask off, in its stored form. The summary is built again from the result with a sentinel for every title, so that the sentence says where each title stands and which element it is;
 * a sentence that does not come out the same when the titles are put back (a shortened title, an anchor the build did not know, a summary that does not follow from the result) is `unbound`. A title of a cited element is a binding to its title; a title of an
 * element the sentence does not cite is no binding and makes the sentence `unbound`; a sentence with no title is `frozen`. The bindings are kept beside the item so that the write check compares them, not only the text they make.
 */
function askItemOf(index: number, text: string, citedRefs: readonly Cite[], again: { readonly summary: AskSummaryShape; readonly probe: Probe } | undefined): Item {
  const unbound: Item = { form: 'unbound', text };
  const probed = again?.summary.sentences[index];
  if (again === undefined || probed === undefined || /[\ue000-\uefff]/u.test(text)) return unbound;
  const keyed = new Map(again.summary.citations.map((citation) => [citation.key, JSON.stringify(citation.element)] as const));
  const asked = new Set(citedRefs.map((ref) => JSON.stringify(ref)));
  const probedRefs = new Set(probed.cites.map((key) => keyed.get(key)));
  if (asked.size !== probedRefs.size || [...asked].some((ref) => !probedRefs.has(ref))) return unbound;
  const segments: Segment[] = [];
  let rebuilt = '';
  let at = 0;
  const literal = (piece: string): void => {
    if (piece === '') return;
    const last = segments[segments.length - 1];
    if (last !== undefined && 'literal' in last) last.literal += piece;
    else segments.push({ literal: piece });
    rebuilt += piece;
  };
  let titled = false;
  for (const match of probed.text.matchAll(SENTINEL)) {
    literal(probed.text.slice(at, match.index));
    const id = [...match[0]].find((character) => (character.codePointAt(0) ?? 0) >= ID0) as string;
    const owner = (id.codePointAt(0) ?? 0) - ID0;
    const shown = again.probe.written.get(owner);
    const element = again.probe.owners.get(owner);
    if (shown === undefined || element === undefined) return unbound;
    titled = true;
    if (!again.probe.bindable.has(owner)) literal(shown);
    else if (asked.has(JSON.stringify(element))) {
      segments.push({ element, property: SENSITIVE_TITLE_KEY });
      rebuilt += shown;
    } else return unbound;
    at = match.index + match[0].length;
  }
  literal(probed.text.slice(at));
  if (rebuilt !== text) return unbound;
  if (!titled || segments.every((segment) => 'literal' in segment)) return { form: 'frozen', text };
  if (segments.length > THREAD_SEGMENTS_MAX || text.length > 2000) return unbound;
  const item: Item = { form: 'bound', segments };
  ORIGINAL.set(item, text);
  ASK_EXPECTED.set(item, JSON.stringify({ segments, text }));
  return item;
}

type AskSummaryShape = { readonly sentences: readonly { readonly text: string; readonly cites: readonly string[] }[]; readonly citations: readonly { readonly key: string; readonly element: Cite }[] };

/** The stored form of Ask's own answer inside a turn: its refusal as a refusal block, and its cited summary as a block of sentences (written with the mask on as frozen; with it off bound to the titles it cites), and the result card. */
function askAnswerStored(ask: Extract<AssistantTurnAnswer, { answer: unknown }>['answer'], maskOn: boolean, result: (blocks: Block[], refs?: ReadonlyMap<string, Cite>) => StoredAnswerResult): StoredAnswerResult | undefined {
  if ('refused' in ask) return result([{ kind: 'refusal', sentence: { form: 'frozen', text: ask.refused.sentence } }]);
  const { summary } = ask.answered;
  const refs = new Map((summary?.citations ?? []).map((citation) => [citation.key, citation.element] as const));
  let again: { readonly summary: AskSummaryShape; readonly probe: Probe } | undefined;
  if (!maskOn && summary !== undefined) {
    const probe = probeOf(ask.answered.result);
    if (probe !== undefined) {
      const cites = (key: string): string | undefined => refs.get(key) === undefined ? undefined : JSON.stringify(refs.get(key));
      const agrees = (built: AskSummaryShape): boolean => {
        const keyed = new Map(built.citations.map((citation) => [citation.key, JSON.stringify(citation.element)] as const));
        return built.sentences.every((sentence, index) => {
          const original = summary.sentences[index];
          const mine = new Set(sentence.cites.map((key) => keyed.get(key)));
          const theirs = new Set((original?.cites ?? []).map(cites));
          return withTitles(sentence.text, probe) === original?.text && mine.size === theirs.size && [...theirs].every((ref) => mine.has(ref));
        });
      };
      const build = (anchor: ElementRef | undefined): AskSummaryShape | undefined => {
        const built = buildSummary(probe.result, anchor === undefined ? {} : { anchor });
        return built !== undefined && built.sentences.length === summary.sentences.length ? built : undefined;
      };
      const first = build(undefined);
      let chosen = first !== undefined && agrees(first) ? first : undefined;
      // only a template that names the anchor of its run in its sentences can have been built with one the answer does not name: it is looked for among the elements the result holds, one build at a time, and the search stops at the first that gives the sentences and their citations
      if (chosen === undefined && ANCHORED_TEMPLATES.has(ask.answered.result.templateId)) {
        const candidates = [...new Map([...probe.owners.values()].map((ref) => [JSON.stringify(ref), ref] as const)).values()].slice(0, ANCHOR_TRIES_MAX);
        for (const anchor of candidates) {
          const built = build(anchor);
          if (built !== undefined && agrees(built)) {
            chosen = built;
            break;
          }
        }
      }
      const fallback = chosen ?? first;
      if (fallback !== undefined) again = { summary: fallback, probe };
    }
  }
  const items = (summary?.sentences ?? []).map((sentence, index) => {
    const cited = sentence.cites.flatMap((key) => (refs.has(key) ? [refs.get(key) as Cite] : []));
    const item = maskOn ? ({ form: 'frozen', text: sentence.text } as const) : askItemOf(index, sentence.text, cited, again);
    const withCites = { ...item, cites: cited };
    ORIGINAL.set(withCites, sentence.text);
    const expected = ASK_EXPECTED.get(item);
    if (expected !== undefined) ASK_EXPECTED.set(withCites, expected);
    return withCites;
  });
  const card = storedAskResultOf(ask, maskOn);
  const blocks = [...(items.length === 0 ? [] : [{ kind: 'sentences', items }]), ...(card === undefined ? [] : [card])];
  return blocks.length === 0 ? undefined : result(blocks as Block[], refs);
}

export function storedAnswerOf(answer: AssistantTurnAnswer, maskOn: boolean, classify?: ClassifyItem): StoredAnswerResult | undefined {
  const fixed = (text: string): TextItem => ({ form: 'frozen', text });
  const citedRefs = (keys: readonly string[], refs: ReadonlyMap<string, Cite>): Cite[] => keys.flatMap((key) => (refs.has(key) ? [refs.get(key) as Cite] : []));
  const sentences = (list: readonly Sentence[], refs: ReadonlyMap<string, Cite>) =>
    list.map((sentence) => {
      const item = itemOf(sentence.text, sentence.cites.filter((key) => refs.has(key)), refs, maskOn, 2000, classify);
      const withCites = { ...item, cites: citedRefs(sentence.cites, refs) };
      ORIGINAL.set(withCites, sentence.text);
      return withCites;
    });
  const labelItem = (label: string): TextItem => ({ form: maskOn ? 'frozen' : classify?.(label, [])?.form === 'frozen' ? 'frozen' : 'unbound', text: label });
  const result = (blocks: Block[], refs: ReadonlyMap<string, Cite> = new Map()): StoredAnswerResult => {
    const inverse = new Map([...refs].map(([key, ref]) => [JSON.stringify(ref), key] as const));
    return { answer: { blocks }, keyOf: (ref) => inverse.get(JSON.stringify(ref)) };
  };
  if (answer.status === 'not-answered') return result([{ kind: 'refusal', sentence: fixed(answer.sentence) }]);
  // what the server answers from the operator's own text, with no model and no element: each type and its description, and the fixed sentence for the types that have none
  if (answer.status === 'meaning') {
    const described = answer.described.map((entry) => ({ ...fixed(`${entry.typeKind === 'entity' ? 'Entity' : 'Relationship'} type ${entry.type}: ${entry.description}`), cites: [] as Cite[] }));
    const missing = answer.noDescription === undefined ? [] : [{ ...fixed(answer.noDescription.sentence), cites: [] as Cite[] }];
    return result([{ kind: 'sentences', items: [...described, ...missing] }] as Block[]);
  }
  if (answer.status === 'no-description') return result([{ kind: 'sentences', items: [{ ...fixed(answer.sentence), cites: [] as Cite[] }] }] as Block[]);
  if (answer.status !== 'answered') return undefined;
  if ('answer' in answer) return askAnswerStored(answer.answer, maskOn, result);
  if (answer.route === 'refuse') {
    const refs = answer.overview === undefined ? new Map<string, Cite>() : refsOf(answer.overview.citations);
    return result([{ kind: 'refusal', sentence: fixed(answer.sentence), ...(answer.overview === undefined ? {} : { overview: sentences(answer.overview.sentences, refs) }) }] as Block[], refs);
  }
  if (!('citations' in answer)) return undefined;
  const refs = refsOf(answer.citations);
  // the fixed sentences of the server (a type with no description, a pointer, the note of the last call) are a block of their own, kept as written
  const server = [answer.noDescription, answer.pointer, answer.lastCallNote].flatMap((text) => (text === undefined || text === '' ? [] : [{ ...fixed(text), cites: [] as Cite[] }]));
  const fixedBlock: Block[] = server.length === 0 ? [] : [{ kind: 'sentences', items: server }];
  if (!('blocks' in answer)) return undefined;
  const stored: Block[] = answer.blocks.map((block): Block => {
    if (block.kind === 'sentences') return { kind: 'sentences', items: sentences(block.sentences, refs) } as Block;
    if (block.kind === 'list') return { kind: 'list', ...(block.label === undefined ? {} : { label: labelItem(block.label) }), items: sentences(block.items, refs) } as Block;
    const { table } = block;
    const labels = table.columns.map((label) => ({ form: maskOn ? ('frozen' as const) : classify?.(label, [])?.form === 'frozen' ? ('frozen' as const) : ('unbound' as const), text: label }));
    const rows = table.rows.map((row) => ({ cells: row.cells.map((cell) => itemOf(cell, row.cites.filter((key) => refs.has(key)), refs, maskOn, 80, classify)), cites: citedRefs(row.cites, refs) }));
    // what the title and the note say, as references and numbers: the type of the rows, the title of the element a read listed them from (source text the model never wrote, so nothing classifies it: `frozen`, as shown, only with the mask on, and `unbound` with the mask off, so that it is withheld under the mask whatever the classifier would say of other text), and the properties whose unit the note gives; the words are written again from the mapping
    const caption = { ...(table.subject === undefined ? {} : { subject: table.subject }), ...(table.anchor === undefined ? {} : { anchor: { form: maskOn ? ('frozen' as const) : ('unbound' as const), text: table.anchor } }) };
    return { kind: 'table', caption, ...(table.units === undefined || table.units.length === 0 ? {} : { units: table.units.map(({ type, property }) => ({ type, property })) }), ...(table.droppedRows === undefined ? {} : { droppedRows: table.droppedRows }), ...(table.moreNotShown === undefined ? {} : { moreNotShown: table.moreNotShown }), columns: labels, rows };
  });
  // how the answer was made, as the server wrote it: counts and type names, no value
  const made = { model: answer.model, coverage: { retrieval: answer.coverage.retrieval, summary: answer.coverage.summary, ...('summaryCited' in answer.coverage && answer.coverage.summaryCited !== undefined ? { summaryCited: answer.coverage.summaryCited } : {}) } };
  return withMade(result([...stored, ...fixedBlock], refs), made);
}

/**
 * Whether every binding of a stored answer is the one the classifier approves for its item, for the elements this turn sent: each bound item is rebuilt, its literals and the value sent for each binding (the element's key and the property, from the
 * provenance), and classified again with the keys of the elements the item cites; it must come out `bound` with the same spans, and every binding is to an element of the turn's source. A strict schema cannot say that (it has no provenance), so the
 * write is validated here, and refused as a whole when a binding is to anything else: another property the element holds, an element cited only by another item, an element of another source, or no provenance at all.
 */
export function bindingsApproved(stored: StoredAnswer, context: ClassifyContext, keyOf: (ref: Cite) => string | undefined, sourceId: string | undefined): boolean {
  type Segment = { readonly literal: string } | { readonly element: Cite; readonly property: string };
  const itemsOf = (block: Block): { readonly item: { readonly form: string; readonly segments?: readonly Segment[] }; readonly cites: readonly Cite[] }[] =>
    block.kind === 'ask-result' ? [] : block.kind === 'sentences' || block.kind === 'list' ? block.items.map((item) => ({ item, cites: item.cites })) : block.kind === 'table' ? block.rows.flatMap((row) => row.cells.map((item) => ({ item, cites: row.cites }))) : (block.overview ?? []).map((item) => ({ item, cites: item.cites }));
  for (const { item, cites } of stored.blocks.flatMap(itemsOf)) {
    if (item.form !== 'bound') continue;
    const askExpected = ASK_EXPECTED.get(item);
    if (askExpected !== undefined) {
      // an item of an Ask summary: its segments and its text are those the summary was built again with, every binding is to the title of a cited element of this source
      const original = ORIGINAL.get(item);
      if (original === undefined || askExpected !== JSON.stringify({ segments: item.segments, text: original })) return false;
      for (const segment of item.segments ?? []) {
        if ('literal' in segment) continue;
        if (segment.property !== SENSITIVE_TITLE_KEY || keyOf(segment.element) === undefined || (sourceId !== undefined && (segment.element as { sourceId?: string }).sourceId !== sourceId)) return false;
      }
      continue;
    }
    if (context.sentValues === undefined || context.sensitiveKeys === undefined) return false;
    let text = '';
    const expected: { start: number; end: number; element: string; property: string }[] = [];
    for (const segment of item.segments ?? []) {
      if ('literal' in segment) {
        text += segment.literal;
        continue;
      }
      const key = keyOf(segment.element);
      const sent = key === undefined ? undefined : context.sentValues.get(key)?.find((value) => value.key === segment.property && !value.masked)?.text;
      if (key === undefined || sent === undefined || (sourceId !== undefined && (segment.element as { sourceId?: string }).sourceId !== sourceId)) return false;
      const start = text.length;
      text += sent.normalize('NFC').trim();
      expected.push({ start, end: text.length, element: key, property: segment.property });
    }
    const cited = cites.flatMap((ref) => {
      const key = keyOf(ref);
      return key === undefined ? [] : [key];
    });
    // the item is rebuilt from its bindings: it must read as the text it was made from, so that a binding to another property or element that holds another value is refused
    if (ORIGINAL.get(item)?.normalize('NFC') !== text) return false;
    const again = classifyItem(text, cited, context);
    if (again.form !== 'bound' || JSON.stringify(again.spans) !== JSON.stringify(expected)) return false;
  }
  return true;
}
