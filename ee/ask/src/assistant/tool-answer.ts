import { ASSISTANT_CITATION_TITLE_MAX, ASSISTANT_READ_FINDING_MAX, ASSISTANT_TABLE_ROWS_MAX, type AssistantTable, type AskRunResult, type GraphEdge, type GraphNode, type SummaryReading, type AssistantFailureKind, type AssistantTurnAnswer, type SummarySentence } from '@neburyx/contracts';
import type { RankedProperty } from '@neburyx/ee-ai-runtime';
import { type AssembledText, edgeDetailOf, propertiesOf, rankedOf, sentValuesOf, valueKeysOf, type SentValue } from '../case-summary/assemble.js';
import { retrievalLine, viewCoverageOf } from '../case-summary/coverage.js';
import type { DraftedOrAlternative } from '../case-summary/draft.js';
import { checkedTextOf } from '../case-summary/judge.js';
import { listedElements } from '../summary/index.js';
import { countOf, coverageOf, degreeCountsOf, inexactCountOf } from './coverage.js';
import { rowsPhrase, subjectPluralOf, subjectTypeOf } from './table.js';
import { noteOfTable } from './blocks.js';
import type { NoteSentence, StepScope } from './tool-step.js';
import { descriptionCitationsOf, noDescriptionReplyOf, noDescriptionSentence, typeLinesOf, undescribedNamesOf, undescribedOf, withTypeLines } from './type-lines.js';
import { refId } from '../summary/title.js';

export interface ReadDone {
  readonly tool: string;
  /** The plain-words label of the intent that was read, when it has one: the reads text says `read of <label>`. */
  readonly label?: string;
  readonly result?: AskRunResult;
  /** The lines of the typology, for the read of that tool: operator text, which the answer may cite by the keys `t1`, `t2`, … */
  readonly typology?: readonly string[];
  /** The model-written sentences of an application read (the person's AI notes, or the AI case summary), with the elements each rests on, and how many entries of the notes were not read. */
  readonly written?: { readonly sentences: readonly NoteSentence[]; readonly notRead: number };
}

export interface ToolAnswerInput {
  readonly scope: StepScope;
  readonly message: string;
  /** The reads of the turn in order: the tool and what it returned, or nothing for a read that found nothing. */
  readonly reads: readonly ReadDone[];
  /** What the view showed, when the turn read it: its elements keep the keys the view read gave them. */
  readonly view?: { readonly assembled: AssembledText; readonly reading: SummaryReading };
}

export type ToolAnswerOutcome =
  | { readonly kind: 'sentences'; readonly sentences: readonly SummarySentence[]; readonly citations: Extract<AssistantTurnAnswer, { status: 'answered'; blocks: unknown }>['citations']; readonly coverage: { readonly retrieval: string; readonly summary: string }; readonly model: string; readonly calls: number; readonly noDescription?: string; readonly pointer?: string; readonly lastCallNote?: string }
  /** The answer as a table (the router chose the form): rows that each cite an element a read returned. */
  | { readonly kind: 'table'; readonly table: AssistantTable; readonly citations: Extract<AssistantTurnAnswer, { status: 'answered'; blocks: unknown }>['citations']; readonly coverage: { readonly retrieval: string; readonly summary: string }; readonly model: string; readonly calls: number; readonly noDescription?: string; readonly pointer?: string; readonly lastCallNote?: string }
  /** The question is about types the mapping does not describe: the fixed sentence the server wrote and the names of the profile. */
  | { readonly kind: 'noDescription'; readonly sentence: string; readonly names: readonly string[]; readonly calls: number }
  | { readonly kind: 'unsupported'; readonly calls: number }
  | { readonly kind: 'limit'; readonly limit: 'calls' | 'time' | 'input'; readonly calls: number }
  | { readonly kind: 'failed'; readonly why: AssistantFailureKind; readonly calls: number };

type ElementKey = NonNullable<ReturnType<AssembledText['keys']['get']>>;

export const failureOf = (kind: string): AssistantFailureKind => (kind === 'timeout' ? 'timeout' : kind === 'rate-limited' ? 'rate-limit' : 'service');

/** A bracketed group of keys, of which those that hold a note's sentence (`a`) are taken out of a sentence's text: the group goes when it holds nothing else, and keeps the other keys otherwise, so that the checks take them out as they take out the keys of elements. */
const KEY_GROUP_OF_TEXT = /\s*[(\[]\s*[nerastm]\d+(?:\s*(?:,|;|and|&)\s*[nerastm]\d+)*\s*[)\]]/gu;

const withoutNoteKeys = (text: string): string =>
  text.replace(KEY_GROUP_OF_TEXT, (group) => {
    const keys = group.match(/[nerastm]\d+/gu) ?? [];
    if (!keys.some((key) => key.startsWith('a'))) return group;
    const others = keys.filter((key) => !key.startsWith('a'));
    return others.length === 0 ? '' : ` (${others.join(', ')})`;
  });

/**
 * What an `a` key stands for in the checks: the keys of the elements its sentence rests on, as in the view call, so that the text of a note is never a source of a name, a figure or a claim; a key of a note the step did not return stays
 * and fails the check that every key was returned. A key written in a bracketed group is taken out of the text, and one written elsewhere is a name no line holds and removes the sentence.
 */
export function withElementsOfNotes(sentences: readonly SummarySentence[], noteElements: ReadonlyMap<string, readonly string[]>): readonly SummarySentence[] {
  if (noteElements.size === 0) return sentences;
  return sentences.map((sentence) => {
    const cites = [...new Set(sentence.cites.flatMap((cite) => noteElements.get(cite) ?? [cite]))];
    return { text: withoutNoteKeys(sentence.text), cites };
  });
}

/** The title a citation carries: the element's own, cut to what the contract allows (its length in UTF-16 code units, as the schema counts it) without splitting a surrogate pair, and none when it is blank. */
export function citationTitleOf(title: string | undefined): string | undefined {
  if (title === undefined || title.trim() === '') return undefined;
  if (title.length <= ASSISTANT_CITATION_TITLE_MAX) return title;
  const cut = title.slice(0, ASSISTANT_CITATION_TITLE_MAX);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** The finding of a read as a citation carries it: cut to what the contract allows, with an ellipsis, without splitting a surrogate pair. */
export function findingCitationOf(finding: string): string {
  if (finding.length <= ASSISTANT_READ_FINDING_MAX) return finding;
  const cut = finding.slice(0, ASSISTANT_READ_FINDING_MAX - 1);
  return `${/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut}…`;
}

const linesPhrase = (count: number): string => `${count} ${count === 1 ? 'line' : 'lines'}`;
const sentencesPhrase = (count: number): string => `${count} ${count === 1 ? 'sentence' : 'sentences'}`;
const withDegreeCounts = (run: AskRunResult, names?: ReadonlyMap<string, string>): string => {
  const counts = degreeCountsOf(run, names);
  return counts === undefined ? coverageOf(run) : `${coverageOf(run)} · ${counts}`;
};
const findingOf = (read: ReadDone, names?: ReadonlyMap<string, string>): string => (read.typology !== undefined ? linesPhrase(read.typology.length) : read.written !== undefined ? `${sentencesPhrase(read.written.sentences.length)}${read.written.notRead > 0 ? `, ${read.written.notRead} ${read.written.notRead === 1 ? 'entry' : 'entries'} not read` : ''}` : read.result === undefined ? 'found nothing' : withDegreeCounts(read.result, names));
const readLine = (key: string, read: ReadDone, names?: ReadonlyMap<string, string>): string => `${key}: read of ${read.label ?? read.tool}: ${findingOf(read, names)}`;

/**
 * The lines the model may cite. The elements the reads listed, once each (those of a view keep the view's keys, the reads' are r1, r2, ...): the type and the title as the result gave them (masked as it was asked), never
 * a property value. Then one line for each read, written by the server (s1, s2, ...): what the read found with its count and its quality, so that a sentence can state that a read found nothing and the numbers of the
 * sentence are checked against the line it cites. A read's key is no element: it is in the lines and the checked keys, and a sentence that cites it carries a citation of the kind `read` that holds what the server wrote of that read.
 */
export interface AssembledResults {
  readonly assembled: AssembledText;
  /** The keys of lines that state what a read found or are operator text, and are no element. */
  readonly readKeys: readonly string[];
  /** The lines of the AI notes, `a1`, `a2`, …: model-written text given to the model beside the elements and never a source of the checks, so they are not in `assembled`. */
  readonly noteLines: readonly string[];
  /** For each `a` key, the keys of the elements its sentence rests on: what the key stands for in the checks. */
  readonly noteElements: ReadonlyMap<string, readonly string[]>;
}

/** The key of the line that states what the view shows and what is not yet retrieved: no element, so a sentence about what the view does not show can cite it. */
const VIEW_COVERAGE_KEY = 'c1';

export function assembleResults(reads: readonly ReadDone[], view?: AssembledText, names?: ReadonlyMap<string, string>, viewCoverage?: ReturnType<typeof viewCoverageOf>): AssembledResults {
  const inexactCounts = [...(view?.inexactCounts ?? [])];
  const unknownCountKeys = new Set(view?.unknownCountKeys);
  const keys = new Map<string, ElementKey>(view?.keys);
  const lines = new Map<string, string>(view?.lines);
  // an element the view already holds keeps the view's key and its one line
  const seen = new Map<string, string>([...(view?.keys ?? [])].map(([key, held]) => [refId(held.ref as never), key]));
  let carriesPropertyValues = view?.carriesPropertyValues ?? false;
  let number = 0;
  const propertyPart = (listed: { readonly node?: GraphNode | undefined }): string => {
    const properties = listed.node === undefined ? undefined : propertiesOf(listed.node.properties);
    if (properties === undefined || properties.text === '') return '';
    carriesPropertyValues ||= properties.carriesValue;
    return ` | ${properties.text}`;
  };
  // what follows a relationship's ends in the line: how the source holds it, its times, its member count and its properties, as the view writes them
  const edgePart = (listed: { readonly edge?: GraphEdge | undefined }, key: string): string => {
    if (listed.edge === undefined) return '';
    const detail = edgeDetailOf(listed.edge);
    carriesPropertyValues ||= detail.carriesValue;
    if (detail.inexact !== undefined) inexactCounts.push(detail.inexact);
    if (detail.unknownCount) unknownCountKeys.add(key);
    return detail.parts.length === 0 ? '' : ` | ${detail.parts.join(' | ')}`;
  };
  // the reads whose result lists elements and no relationship: their line says so, and a direction is not known from them
  const noRelationship = new Set<number>();
  const propertyKeys = new Map<string, readonly string[]>(view?.propertyKeys);
  const rankedValues = new Map<string, readonly RankedProperty[]>(view?.rankedValues);
  const sentValues = new Map<string, readonly SentValue[]>(view?.sentValues);
  const readElements = new Map<string, string[]>();
  const relationshipEnds = new Map<string, readonly (readonly [string, string])[]>(view?.relationshipEnds);
  const keyFor = (id: string, element: ElementKey['ref'], type: string, title: string): string => {
    const held = seen.get(id);
    if (held !== undefined) return held;
    number += 1;
    const key = `r${number}`;
    seen.set(id, key);
    keys.set(key, 'entityType' in element ? { kind: 'entity', ref: element, title } : { kind: 'relationship', ref: element, title });
    lines.set(key, 'entityType' in element ? `${key}: ${type}: ${title}` : `${key}: ${title}`);
    return key;
  };
  reads.forEach((read, readIndex) => {
    const listedOfRead = read.result === undefined ? undefined : listedElements(read.result);
    if (listedOfRead !== undefined && listedOfRead.size > 0 && ![...listedOfRead.values()].some((item) => !('entityType' in item.element))) noRelationship.add(readIndex);
    const listedKeys: string[] = [];
    readElements.set(`s${readIndex + 1}`, listedKeys);
    for (const [id, listed] of listedOfRead ?? []) {
      if (seen.has(id)) {
        const held = seen.get(id);
        if (held !== undefined && held !== '') listedKeys.push(held);
        continue;
      }
      seen.set(id, '');
      number += 1;
      const key = `r${number}`;
      seen.set(id, key);
      // the title the result gave, masked as it was asked, goes with the key: an element the person has not drawn is still named
      keys.set(key, 'entityType' in listed.element ? { kind: 'entity', ref: listed.element, title: listed.title } : { kind: 'relationship', ref: listed.element, title: listed.title });
      // a relationship's title already begins with its type
      lines.set(key, 'entityType' in listed.element ? `${key}: ${listed.type}: ${listed.title}${propertyPart(listed)}` : `${key}: ${listed.title}${edgePart(listed, key)}`);
      listedKeys.push(key);
      if (listed.edge !== undefined) relationshipEnds.set(key, [[listed.edge.from.entityType, listed.edge.from.stableId], [listed.edge.to.entityType, listed.edge.to.stableId]]);
      const held = listed.node ?? listed.edge;
      if (held !== undefined) {
        propertyKeys.set(key, valueKeysOf(held.properties));
        rankedValues.set(key, rankedOf(held.properties));
        sentValues.set(key, sentValuesOf(held.properties, listed.node === undefined ? undefined : listed.title));
      } else if ('entityType' in listed.element) {
        sentValues.set(key, sentValuesOf([], listed.title));
      }
    }
  });
  // the lines of the typology: operator text, each with a key of its own that is no element
  let typologyNumber = 0;
  const typologyKeys: string[] = [];
  for (const read of reads) {
    for (const line of read.typology ?? []) {
      typologyNumber += 1;
      const key = `t${typologyNumber}`;
      typologyKeys.push(key);
      lines.set(key, `${key}: ${line}`);
    }
  }
  // the sentences of the person's AI notes: each with a key of its own and the elements it rests on, which keep the keys of the elements of the reads
  let noteNumber = 0;
  const noteLines: string[] = [];
  const noteElements = new Map<string, readonly string[]>();
  for (const read of reads) {
    for (const sentence of read.written?.sentences ?? []) {
      noteNumber += 1;
      const key = `a${noteNumber}`;
      const rests = [...new Set(sentence.citations.map((citation) => keyFor(refId(citation.ref as never), citation.ref as ElementKey['ref'], citation.type, citation.kind === 'relationship' ? `${citation.type}: ${citation.title}` : citation.title)))];
      noteElements.set(key, rests);
      noteLines.push(`${key}: ${sentence.text}${rests.length === 0 ? '' : ` (rests on ${rests.join(', ')})`}`);
    }
  }
  const coverageKeys = viewCoverage === undefined ? [] : [VIEW_COVERAGE_KEY];
  if (viewCoverage !== undefined) {
    lines.set(VIEW_COVERAGE_KEY, `${VIEW_COVERAGE_KEY}: view coverage: ${viewCoverage.text}`);
    if (viewCoverage.inexact === 'unknown') unknownCountKeys.add(VIEW_COVERAGE_KEY);
    else if (viewCoverage.inexact !== undefined) inexactCounts.push(viewCoverage.inexact);
  }
  const readKeys = [...coverageKeys, ...reads.map((_, index) => `s${index + 1}`), ...typologyKeys];
  reads.forEach((read, index) => {
    lines.set(`s${index + 1}`, `${readLine(`s${index + 1}`, read, names)}${noRelationship.has(index) ? ' · no relationship listed' : ''}`);
    const inexact = read.result === undefined ? undefined : inexactCountOf(read.result);
    if (inexact === 'unknown') unknownCountKeys.add(`s${index + 1}`);
    else if (inexact !== undefined) inexactCounts.push(inexact);
  });
  return { assembled: { text: [...lines.values()].join('\n'), keys, lines, inexactCounts, unknownCountKeys, carriesPropertyValues, propertyKeys, readElements, relationshipEnds, rankedValues, sentValues }, readKeys, noteLines, noteElements };
}

const NOTES_HEADING = "Sentences written by a model: the AI notes the person copied into this investigation's draft, or an AI case summary drafted for this turn (each lists the elements it rests on; cite those elements, or its a key, and never copy a name, a figure or a claim from it that the elements do not state)";

const valuesOf = (message: string, assembled: AssembledText, coverage: string, context?: string, noteLines: readonly string[] = []): string => `Question:\n${message}\n\nWhat the reads returned (cite an s line to state what a read found, including that it found nothing; a t line is a line of the product's list of shapes of money movement, which may be cited to name a shape):\n${assembled.text}${noteLines.length === 0 ? '' : `\n\n${NOTES_HEADING}:\n${noteLines.join('\n')}`}\n\nCoverage:\n${coverage}${context === undefined ? '' : `\n\nEarlier turns of this conversation, given only so that the question can be placed (their keys, such as c1, are not elements in view and are never cited):\n${context}`}`;

export interface AnswerBasis {
  readonly assembled: AssembledText;
  readonly readKeys: readonly string[];
  readonly noteLines: readonly string[];
  readonly noteElements: ReadonlyMap<string, readonly string[]>;
  readonly coverage: string;
  /** The text of the line `c1`, when the turn has a view: what its citation shows. */
  readonly viewCoverage?: string;
  readonly typeLines: ReturnType<typeof typeLinesOf>;
  readonly checkedText: ReturnType<typeof withTypeLines>;
}

/** What an answer is checked against: the lines the reads returned, the coverage the server writes for them, the type descriptions in play and the text the checks read; undefined when the reads returned nothing to cite. */
/** The display name of each entity type of the source, for the lines that name the type of the elements a count is of. */
export const typeNamesOf = (request: { readonly typeDescriptions?: (sourceId: string) => { readonly entityTypes: readonly { readonly type: string; readonly displayName: string }[] } }, sourceId: string): ReadonlyMap<string, string> =>
  new Map((request.typeDescriptions?.(sourceId).entityTypes ?? []).map((entity) => [entity.type, entity.displayName]));

export function answerBasisOf(input: Pick<ToolAnswerInput, 'reads' | 'view' | 'scope' | 'message'>): AnswerBasis | undefined {
  const names = typeNamesOf(input.scope.request, input.scope.sourceId);
  const viewCoverage = input.view === undefined ? undefined : viewCoverageOf(input.view.reading, names);
  const { assembled, readKeys, noteLines, noteElements } = assembleResults(input.reads, input.view?.assembled, names, viewCoverage);
  if (assembled.keys.size === 0 && readKeys.length === 0) return undefined;
  const coverage = [...(input.view === undefined ? [] : [`view: ${retrievalLine(input.view.reading)}`]), ...input.reads.map((read, index) => `read ${index + 1}, ${read.tool}: ${findingOf(read, names)}`)].join('; ');
  const typeLines = typeLinesOf(input.scope.request.typeDescriptions?.(input.scope.sourceId), assembled, input.message, input.scope.askedTypes, input.scope.contextTypes);
  const checkable = checkedTextOf(assembled);
  const checkedText = withTypeLines({ ...checkable, keys: new Map([...checkable.keys, ...readKeys.map((key) => [key, true] as const)]), readKeys: new Set(readKeys) }, typeLines);
  return { assembled, readKeys, noteLines, noteElements, coverage, ...(viewCoverage === undefined ? {} : { viewCoverage: viewCoverage.text }), typeLines, checkedText };
}

interface DraftContext {
  readonly drafted: DraftedOrAlternative;
  readonly basis: AnswerBasis;
  readonly input: Pick<ToolAnswerInput, 'reads' | 'scope'>;
  readonly modelRef: string;
  readonly keptRows: readonly number[];
  readonly lastNames: readonly string[] | undefined;
}

/** The outcome of an answer for what the model drafted and the checks kept. */
export function outcomeOfDraft(context: DraftContext): ToolAnswerOutcome {
  const { drafted, basis, input, modelRef, keptRows, lastNames } = context;
  const { assembled, coverage, typeLines } = basis;
  switch (drafted.status) {
    case 'alternative': {
      const asked = noDescriptionReplyOf(drafted.text, typeLines);
      if (asked === undefined) return { kind: 'unsupported', calls: drafted.calls };
      const alone = undescribedOf(asked, typeLines);
      return { kind: 'noDescription', sentence: noDescriptionSentence(alone), names: alone, calls: drafted.calls };
    }
    case 'tooLarge':
      return { kind: 'limit', limit: 'input', calls: drafted.calls };
    case 'timeLimit':
      return { kind: 'limit', limit: 'time', calls: drafted.calls };
    case 'failed':
      return drafted.kind === 'format' ? { kind: 'unsupported', calls: drafted.calls } : { kind: 'failed', why: failureOf(drafted.kind), calls: drafted.calls };
    case 'drafted': {
      const fixed = undescribedOf(drafted.noDescription === undefined ? undefined : lastNames, typeLines);
      if (drafted.sentences.length === 0 || drafted.verdictFound) return fixed.length > 0 ? { kind: 'noDescription', sentence: noDescriptionSentence(fixed), names: fixed, calls: drafted.calls } : { kind: 'unsupported', calls: drafted.calls };
      if (drafted.table !== undefined) {
        const draft = drafted.table;
        const rows = keptRows.flatMap((index) => (draft.rows[index] === undefined ? [] : [draft.rows[index]]));
        const shown = rows.slice(0, ASSISTANT_TABLE_ROWS_MAX).map((row) => ({ cells: [...row.cells], cites: [...row.cites] }));
        const cut = rows.length - shown.length;
        const tableCited = [...new Set(shown.flatMap((row) => row.cites))];
        const tableCitations = tableCited.flatMap((key) => {
          const element = assembled.keys.get(key);
          return element === undefined ? [] : [{ key, kind: element.kind, ref: element.ref, ...(citationTitleOf(element.title) === undefined ? {} : { title: citationTitleOf(element.title) }) }];
        });
        const subject = subjectTypeOf(shown, assembled);
        const plural = subjectPluralOf(subject, input.scope.request.typeDescriptions?.(input.scope.sourceId));
        // one read that listed every row's first element, from an expand of one titled element: the title of that element
        const withResult = input.reads.filter((read) => read.result !== undefined);
        const only = withResult.length === 1 ? withResult[0] : undefined;
        const readIndex = only === undefined ? -1 : input.reads.indexOf(only);
        const listed = assembled.readElements?.get(`s${readIndex + 1}`);
        let anchorTitle: string | undefined;
        if (only?.result?.templateId === 'expand' && listed !== undefined && shown.every((row) => row.cites[0] !== undefined && listed.includes(row.cites[0]))) {
          const anchorId = refId(only.result.result.ref);
          anchorTitle = citationTitleOf(listedElements(only.result)?.get(anchorId)?.title);
        }
        const title = `${plural}${anchorTitle === undefined ? '' : ` of ${anchorTitle}`} · ${rowsPhrase(shown.length)}`;
        let shownOf: string;
        const ofSubject = (key: string): boolean => subject !== undefined && subjectTypeOf([{ cites: [key] }], assembled)?.text === subject.text;
        const inReads = subject === undefined ? (listed ?? [...assembled.keys.keys()]).length : (listed ?? [...assembled.keys.keys()]).filter(ofSubject).length;
        if (only?.result !== undefined && listed !== undefined && subject !== undefined && listed.every(ofSubject)) {
          // the read's own count is of the subject type only when the read listed nothing else
          const count = countOf(only.result);
          shownOf = count.value === undefined ? `${shown.length} ${plural.toLowerCase()} read shown · the count is not known` : `${shown.length} of ${count.value} ${plural.toLowerCase()} read shown · ${count.quality === 'lowerBound' ? 'lower bound' : count.quality}`;
        } else {
          shownOf = `${shown.length} of ${inReads} ${plural.toLowerCase()} read shown · exact`;
        }
        const droppedRows = draft.rows.length - rows.length + draft.uncited;
        const note = noteOfTable({ columns: draft.columns, rows: shown, lines: basis.checkedText.lines, elements: assembled.keys, descriptions: input.scope.request.typeDescriptions?.(input.scope.sourceId) });
        return { kind: 'table', table: { title, columns: [...draft.columns], rows: shown, note, ...(droppedRows > 0 ? { droppedRows } : {}), ...(cut > 0 ? { moreNotShown: cut } : {}) }, citations: tableCitations, coverage: { retrieval: coverage, summary: shownOf }, model: modelRef, calls: drafted.calls, ...(fixed.length === 0 ? {} : { noDescription: noDescriptionSentence(fixed) }) };
      }
      const cited = new Set(drafted.sentences.flatMap((sentence) => sentence.cites));
      const citations = [...cited].flatMap((key) => {
        const element = assembled.keys.get(key);
        return element === undefined ? [] : [{ key, kind: element.kind, ref: element.ref, ...(citationTitleOf(element.title) === undefined ? {} : { title: citationTitleOf(element.title) }) }];
      });
      // a cite to a read line (`s1`) is no element: the server writes what that read found, as a marker of its own beside the sentence
      const names = typeNamesOf(input.scope.request, input.scope.sourceId);
      const readCitations = [...cited].flatMap((key) => {
        if (key === VIEW_COVERAGE_KEY && basis.viewCoverage !== undefined) return [{ key, kind: 'read' as const, label: 'View coverage', finding: findingCitationOf(basis.viewCoverage) }];
        const index = /^s(\d+)$/.exec(key)?.[1];
        const read = index === undefined ? undefined : input.reads[Number(index) - 1];
        return read === undefined ? [] : [{ key, kind: 'read' as const, label: citationTitleOf(read.label ?? read.tool) ?? read.tool, finding: findingCitationOf(findingOf(read, names)) }];
      });
      const withDescriptions = [...citations, ...descriptionCitationsOf(drafted.sentences, typeLines), ...readCitations];
      return { kind: 'sentences', sentences: drafted.sentences, citations: withDescriptions, coverage: { retrieval: coverage, summary: `The answer cites ${citations.length} of the ${assembled.keys.size} elements the reads returned.` }, model: modelRef, calls: drafted.calls, ...(fixed.length === 0 ? {} : { noDescription: noDescriptionSentence(fixed) }) };
    }
    default: {
      const unreachable: never = drafted;
      return unreachable;
    }
  }
}
