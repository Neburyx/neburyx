import { AI_NOTES_MAX_ENTRIES, AI_NOTES_MAX_SENTENCES, ExtensionRefusal, aiNotesQuerySchema, aiNotesResponseSchema, copyToNotesParamsSchema, type AiNotesCapability, type AiNotesResponse, type ExtensionRequest, type ExtensionRoute, type SummaryReading, type ElementsScope, type ElementRefs } from '@neburyx/contracts';
import { gateClientOf } from '@neburyx/ee-ai-runtime';
import { parseStoredEntry, rebuildEntry, refsOf, type RebuiltEntry, type StoredEntry } from './notes-rebuild.js';

const READ_URL = '/v1/investigations/:id/draft/ai-notes';

type Skipped = AiNotesResponse['skipped'][number];

const referenceCount = (entry: StoredEntry): number => {
  const refs = refsOf([entry]);
  return refs.entities.length + refs.edges.length + refs.aggregates.length + refs.derived.length;
};

const countOf = (value: unknown): number | undefined => (Array.isArray(value) ? value.length : undefined);

/** Whether a stored value is over the bounds an entry has when it is stored, decided from its two arrays before the value is parsed. */
function overBounds(stored: Readonly<Record<string, unknown>>, maxRefs: number): boolean {
  const sentences = countOf(stored['sentences']);
  const refs = countOf(stored['inputRefs']);
  return (sentences !== undefined && sentences > AI_NOTES_MAX_SENTENCES) || (refs !== undefined && refs > maxRefs);
}

export interface RebuiltNotes {
  readonly entries: readonly RebuiltEntry[];
  readonly skipped: readonly Skipped[];
  /** Whether the gate was asked for the elements the entries rest on, and what it gave back. */
  readonly reading?: SummaryReading;
}

/**
 * Reads the AI notes stored with the caller's own draft of an investigation and rebuilds each entry for them through the gate, all entries in one batch: titles as they are shown, their own count phrases and quality labels, sentences they may not be shown left out.
 * An entry over the bounds an entry has when it is stored, or one that is not of the stored shape, is not read and is named with a fixed reason. With no entry to rebuild the gate is not asked.
 */
export async function rebuildNotesFor(input: { readonly aiNotes: AiNotesCapability; readonly readElements: (scope: ElementsScope, refs: ElementRefs) => Promise<SummaryReading>; readonly investigationId: string; readonly sourceId: string; readonly mask: boolean; readonly maxRefs: number; readonly signal?: AbortSignal }): Promise<RebuiltNotes> {
  const held = await input.aiNotes.read(input.investigationId);
  const skipped: Skipped[] = [];
  const entries: StoredEntry[] = [];
  held.entries.forEach((stored, index) => {
    const tokenId = typeof stored['tokenId'] === 'string' ? stored['tokenId'] : 'unknown';
    if (index >= AI_NOTES_MAX_ENTRIES || overBounds(stored, input.maxRefs)) {
      skipped.push({ tokenId, reason: 'too-large' });
      return;
    }
    const entry = parseStoredEntry(stored);
    if (entry === undefined) skipped.push({ tokenId, reason: 'unreadable' });
    else if (referenceCount(entry) > input.maxRefs) skipped.push({ tokenId, reason: 'too-large' });
    else entries.push(entry);
  });
  if (entries.length === 0) return { entries: [], skipped };
  const reading = await input.readElements({ investigationId: input.investigationId, sourceId: input.sourceId, mask: input.mask, ...(input.signal === undefined ? {} : { signal: input.signal }) }, refsOf(entries));
  return { entries: entries.map((entry) => rebuildEntry(entry, reading)), skipped, reading };
}

/**
 * The route that reads the AI notes of the caller's draft: each entry rebuilt for them through the gate (see `rebuildNotesFor`), with a coverage line built for them.
 */
export function createReadAiNotesRoute(options: { readonly maxRefs: () => number }): ExtensionRoute {
  return {
    method: 'GET',
    url: READ_URL,
    permission: 'principal',
    params: copyToNotesParamsSchema,
    query: aiNotesQuerySchema,
    investigation: { param: 'id', missing: 'NOT_FOUND' },
    responseSchema: aiNotesResponseSchema,
    async handler(request: ExtensionRequest): Promise<AiNotesResponse> {
      const { investigation, aiNotes } = request;
      const { readElements, investigationReadable, sourceReadable } = gateClientOf(request);
      if (investigation === undefined || aiNotes === undefined || readElements === undefined || investigationReadable === undefined || sourceReadable === undefined) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      const mask = aiNotesQuerySchema.parse(request.query).mask === 'true';
      const rebuilt = await rebuildNotesFor({ aiNotes, readElements, investigationId: investigation.id, sourceId: investigation.sourceId, mask, maxRefs: options.maxRefs() });
      if (rebuilt.reading === undefined) {
        await investigationReadable(investigation.id, investigation.sourceId);
        await sourceReadable(investigation.sourceId);
        return { entries: [], skipped: [...rebuilt.skipped] };
      }
      return {
        entries: rebuilt.entries.map((entry) => ({ tokenId: entry.tokenId, label: 'AI-drafted' as const, model: entry.modelRef, generatedAt: entry.generatedAt, sentences: entry.sentences.map((sentence) => ({ text: sentence.text, citations: [...sentence.citations] })), coverage: entry.coverage })),
        skipped: [...rebuilt.skipped],
      };
    },
  };
}
