import { ASK_SUMMARY_MAX_CITATIONS, ASK_SUMMARY_MAX_SENTENCE_LENGTH, ASK_SUMMARY_MAX_SENTENCES, type AskSummary, type AskSummaryCitation, type EdgeRef, type ElementRef, type GraphEdge, type GraphNode } from '@neburyx/contracts';
import { refId } from './title.js';

/** An element a result lists, with what a citation holds of it. */
export interface Listed {
  readonly element: ElementRef | EdgeRef;
  readonly type: string;
  readonly title: string;
  /** The node or the relationship the result holds for the element, when it holds one: its projected properties, as the gate returned them. */
  readonly node?: GraphNode;
  readonly edge?: GraphEdge;
}

export type ListedElements = ReadonlyMap<string, Listed>;

export function listOf(items: readonly Listed[]): ListedElements {
  return new Map(items.map((item) => [refId(item.element), item]));
}

const length = (text: string): number => [...text].length;

/** A title that ends with a full stop leaves two at the end of the sentence that closes with its own: one is kept. */
const tidy = (text: string): string => text.replace(/([^.])\.\.$/, '$1.');

/**
 * Builds a summary. A sentence is added with the elements it cites, and every one of them must be one the result lists: a sentence with no element, or with one the result does not list, cannot be built.
 * Keys are given in the order of first citation. When a limit would be passed, the sentence is not added (never cut in the middle) and is counted, and the omissions line says how many were left out;
 * a citation that only a left-out sentence would have cited is never made.
 */
export class SummaryBuilder {
  private readonly sentences: { text: string; cites: string[] }[] = [];
  private readonly citations: AskSummaryCitation[] = [];
  private readonly keys = new Map<string, string>();
  private left = 0;

  constructor(private readonly listed: ListedElements) {}

  add(written: string, elements: readonly (ElementRef | EdgeRef)[]): boolean {
    const text = tidy(written);
    if (elements.length === 0) throw new Error('a sentence cites at least one element');
    const items = elements.map((element) => {
      const item = this.listed.get(refId(element));
      if (item === undefined) throw new Error('a sentence cites an element the result does not list');
      return item;
    });
    const fresh = [...new Set(items.map((item) => refId(item.element)))].filter((id) => !this.keys.has(id));
    if (this.sentences.length >= ASK_SUMMARY_MAX_SENTENCES || length(text) > ASK_SUMMARY_MAX_SENTENCE_LENGTH || this.citations.length + fresh.length > ASK_SUMMARY_MAX_CITATIONS) {
      this.left += 1;
      return false;
    }
    const cites: string[] = [];
    for (const item of items) {
      const id = refId(item.element);
      let key = this.keys.get(id);
      if (key === undefined) {
        key = `n${this.keys.size + 1}`;
        this.keys.set(id, key);
        this.citations.push({ key, element: item.element, type: item.type, title: item.title });
      }
      if (!cites.includes(key)) cites.push(key);
    }
    this.sentences.push({ text, cites });
    return true;
  }

  /** Whether a sentence of this text passes the length limit: asked before a sentence is added, so a shorter one can be tried without counting a left-out statement. */
  fits(text: string): boolean {
    return length(tidy(text)) <= ASK_SUMMARY_MAX_SENTENCE_LENGTH;
  }

  /** The summary, or nothing when no sentence could be built. `omissions` is the line the builder wrote; the number of statements left out is added to it. */
  finish(omissions?: string): AskSummary | undefined {
    if (this.sentences.length === 0) return undefined;
    const leftOut = this.left === 0 ? undefined : `${this.left} ${this.left === 1 ? 'statement was' : 'statements were'} left out.`;
    const line = [omissions, leftOut].filter((part): part is string => part !== undefined).join(' ');
    return { sentences: this.sentences, citations: this.citations, ...(line === '' ? {} : { omissions: length(line) > ASK_SUMMARY_MAX_SENTENCE_LENGTH ? leftOut ?? omissions ?? '' : line }) };
  }
}

/** True when every sentence has a key, every key has a citation, and every citation is of an element the result lists. */
export function citedKeysExist(summary: AskSummary, listed: ListedElements): boolean {
  const held = new Map(summary.citations.map((citation) => [citation.key, citation]));
  return (
    summary.sentences.every((sentence) => sentence.cites.length > 0 && sentence.cites.every((key) => held.has(key))) &&
    summary.citations.every((citation) => listed.has(refId(citation.element)))
  );
}
