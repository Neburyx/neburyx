import { AI_NOTES_MAX_ENTRIES, AI_NOTES_MAX_SENTENCES, ExtensionRefusal, aiNotesQuerySchema, aiNotesResponseSchema, copyToNotesParamsSchema, type AiNotesResponse, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import { parseStoredEntry, rebuildEntry, refsOf, type StoredEntry } from './notes-rebuild.js';

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

/**
 * Reads the AI notes stored with the caller's draft and rebuilds each entry for them through the gate, all entries in one batch: titles as they are shown, their own count phrases and quality labels, sentences they may not see
 * left out, and a coverage line built for them. An entry over the bounds an entry has when it is stored, or one that is not of the stored shape, is not read and is named with a fixed reason.
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
      const { investigation, aiNotes, readElements, investigationReadable, askSourceReadable } = request;
      if (investigation === undefined || aiNotes === undefined || readElements === undefined || investigationReadable === undefined || askSourceReadable === undefined) throw new ExtensionRefusal({ code: 'ASK_UNSUPPORTED', reason: 'not-in-this-edition' });
      const mask = aiNotesQuerySchema.parse(request.query).mask === 'true';
      const held = await aiNotes.read(investigation.id);
      const skipped: Skipped[] = [];
      const entries: StoredEntry[] = [];
      const maxRefs = options.maxRefs();
      held.entries.forEach((stored, index) => {
        const tokenId = typeof stored['tokenId'] === 'string' ? stored['tokenId'] : 'unknown';
        if (index >= AI_NOTES_MAX_ENTRIES || overBounds(stored, maxRefs)) {
          skipped.push({ tokenId, reason: 'too-large' });
          return;
        }
        const entry = parseStoredEntry(stored);
        if (entry === undefined) skipped.push({ tokenId, reason: 'unreadable' });
        else if (referenceCount(entry) > maxRefs) skipped.push({ tokenId, reason: 'too-large' });
        else entries.push(entry);
      });
      if (entries.length === 0) {
        await investigationReadable(investigation.id, investigation.sourceId);
        await askSourceReadable(investigation.sourceId);
        return { entries: [], skipped };
      }
      const reading = await readElements({ investigationId: investigation.id, sourceId: investigation.sourceId, mask }, refsOf(entries));
      return {
        entries: entries.map((entry) => {
          const rebuilt = rebuildEntry(entry, reading);
          return { tokenId: rebuilt.tokenId, label: 'AI-drafted' as const, model: rebuilt.modelRef, generatedAt: rebuilt.generatedAt, sentences: rebuilt.sentences.map((sentence) => ({ text: sentence.text, citations: [...sentence.citations] })), coverage: rebuilt.coverage };
        }),
        skipped,
      };
    },
  };
}
