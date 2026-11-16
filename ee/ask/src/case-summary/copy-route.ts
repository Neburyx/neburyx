import { ExtensionRefusal, copyToNotesParamsSchema, copyToNotesRequestSchema, copyToNotesResponseSchema, type CopyToNotesResponse, type ExtensionRequest, type ExtensionRoute } from '@neburyx/contracts';
import { NOTES_WORD_LIST_VERSION } from './notes-words.js';
import { auditInvestigationOf } from './summarizer.js';
import { openToken } from './token.js';
import type { TokenKeys } from './token-keys.js';

const COPY_URL = '/v1/investigations/:id/draft/ai-notes';

const COPY_CLOSING_ACTION = 'ai.case-summary.copied';

const LABEL = 'AI-drafted';

/** What the application's refusals for an investigation or a draft that cannot be written come to for the person: they lost the right, so the draft must be generated again. */
const LOST_RIGHT: ReadonlySet<string> = new Set(['NOT_FOUND', 'CONFLICT', 'ACCESS_DENIED']);

function codeOf(error: unknown): string | undefined {
  const code: unknown = typeof error === 'object' && error !== null ? Object.getOwnPropertyDescriptor(error, 'code')?.value : undefined;
  return typeof code === 'string' ? code : undefined;
}

/** A refusal of the capability for a lost right is `ACCESS_DENIED` here; a stale version and a list or entry over its bounds keep their own codes. */
function normalised(error: unknown): unknown {
  const code = codeOf(error);
  return code !== undefined && LOST_RIGHT.has(code) ? new ExtensionRefusal({ code: 'ACCESS_DENIED' }) : error;
}

/**
 * Copies the storable sentences of a draft into the AI notes of the view: the token is the only carrier of the draft, and the copy uses only the forms sealed in it at generation, never converting or checking a
 * sentence again. A token that is expired, altered, another person's, for another investigation, from another policy version or word list version, or an investigation the caller may not write, is `ACCESS_DENIED`.
 */
export function createCopyToNotesRoute(options: { readonly tokenKeys: () => TokenKeys | undefined }): ExtensionRoute {
  return {
    method: 'POST',
    url: COPY_URL,
    permission: 'principal',
    params: copyToNotesParamsSchema,
    investigation: { param: 'id', missing: 'ACCESS_DENIED' },
    requestSchema: copyToNotesRequestSchema,
    responseSchema: copyToNotesResponseSchema,
    async handler(request: ExtensionRequest): Promise<CopyToNotesResponse> {
      const role = request.principalRole;
      const keys = options.tokenKeys();
      const { investigation, aiNotes } = request;
      if ((role !== 'administrator' && role !== 'investigator') || keys === undefined || investigation === undefined || aiNotes === undefined || !request.caseSummarizer.availability().available) throw new ExtensionRefusal({ code: 'ACCESS_DENIED' });
      const body = copyToNotesRequestSchema.parse(request.body);
      const opened = openToken(keys, body.summaryToken, { investigationId: investigation.id, actorId: request.principalId, policyVersion: request.policyVersion?.(investigation.sourceId) ?? 'none', now: Date.now() });
      if (!opened.ok || opened.payload.wordListVersion !== NOTES_WORD_LIST_VERSION) throw new ExtensionRefusal({ code: 'ACCESS_DENIED' });
      const { payload } = opened;
      const kept = payload.templates.flatMap((template, index) => (template.storable ? [{ template, index }] : []));
      const notCopied = payload.templates.length - kept.length;
      let answer: CopyToNotesResponse;
      try {
        if (kept.length === 0) {
          await aiNotes.canWrite(investigation.id);
          const held = await aiNotes.read(investigation.id);
          answer = { copied: 0, notCopied, alreadyCopied: false, version: held.version, save: held.save };
        } else {
          const refOf = (key: string) => payload.inputRefs.find((candidate) => candidate.key === key);
          const entry = {
            tokenId: payload.tokenId,
            generatedBy: payload.generatedBy,
            modelRef: payload.modelRef,
            promptId: payload.promptId,
            promptVersion: payload.promptVersion,
            generatedAt: new Date(payload.generatedAt).toISOString(),
            wordListVersion: payload.wordListVersion,
            label: LABEL,
            sentences: kept.map(({ template, index }) => ({ text: template.text, placeholders: template.placeholders, cites: [...new Set(payload.sentences[index]?.cites ?? [])].flatMap((key) => refOf(key) ?? []) })),
            inputRefs: [...payload.inputRefs],
          };
          const stored = await aiNotes.append({ investigationId: investigation.id, expectedVersion: body.version, entry, maxRefs: request.caseSummarizer.maxElements });
          answer = stored.outcome === 'already-stored' ? { copied: 0, notCopied: 0, alreadyCopied: true, version: stored.version, save: stored.save } : { copied: kept.length, notCopied, alreadyCopied: false, version: stored.version, save: stored.save };
        }
      } catch (error) {
        throw normalised(error);
      }
      try {
        await request.audit.record({
          actorId: request.principalId,
          actorRole: role,
          action: COPY_CLOSING_ACTION,
          result: 'success',
          sourceId: investigation.sourceId,
          ...auditInvestigationOf(investigation.id),
          detail: { notes: { runId: payload.runId, copied: answer.copied, notCopied: answer.notCopied, alreadyCopied: answer.alreadyCopied } },
          traceId: request.traceId,
        });
      } catch {
        throw new ExtensionRefusal({ code: 'AUDIT_UNAVAILABLE' });
      }
      return answer;
    },
  };
}
