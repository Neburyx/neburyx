import { ASK_QUESTION_MAX_CODE_POINTS, ASK_SAVED_PATTERN_INTENT, ASK_SAVED_PATTERN_NOTE, readClassification, type AskClassification, type AskClassifier, type AskFolder } from '@neburyx/contracts';
import { AuditUnavailableError, type AuditedModelCall } from '../audited.js';

export const CLASSIFY_PROMPT_ID = 'ask.classify';
export const CLASSIFY_PROMPT_VERSION = 1;
/** The action of the audit event of each classification call. */
export const CLASSIFY_AUDIT_ACTION = 'ask.classify';

export interface ClassifierOptions {
  /** The audited model call: every call it makes writes its event. */
  readonly model: AuditedModelCall;
  /** The folder read at start-up; read at each question so a classifier built early sees it. */
  readonly folder: () => AskFolder | undefined;
}

/** What the call is given besides the instructions: the question, and with a catalog the note and the catalog of the caller's own saved patterns, and nothing else. */
const valuesOf = (question: string, catalog: string | undefined): string => (catalog === undefined ? question : `${question}\n\n${ASK_SAVED_PATTERN_NOTE}\n${catalog}`);

/**
 * The classifier of Ask: one audited model call for a question, with the source's `classification.md` as the instructions of the call (so the audit's prompt hash is that file's hash) and the question as typed as its values.
 * The reply is read strictly; whatever does not fit, and every failure of the provider, is a cause with a fixed sentence and no word of the model. There is no second call after a failure.
 */
export function createAskClassifier(options: ClassifierOptions): AskClassifier {
  return {
    availability: () => ({ available: true }),
    async classify(input, signal): Promise<AskClassification> {
      const length = [...input.question].length;
      if (input.question.trim() === '' || length > ASK_QUESTION_MAX_CODE_POINTS) throw new RangeError('a question is not blank and at most the limit of code points');
      const source = options.folder()?.source(input.sourceId);
      if (source === undefined) return { ok: false, cause: 'no-ask-for-source' };
      let answer;
      try {
        answer = await options.model.call(
          { promptId: CLASSIFY_PROMPT_ID, version: CLASSIFY_PROMPT_VERSION, instructions: source.classification.text, values: valuesOf(input.question, input.patternCatalog) },
          { action: CLASSIFY_AUDIT_ACTION, actorId: input.actorId, actorRole: input.actorRole, traceId: input.traceId, sourceId: input.sourceId, ...(input.investigationId === undefined ? {} : { investigationId: input.investigationId }) },
          signal,
        );
      } catch (error) {
        // the call has written its failed event; only a failure to write it is not an answer
        if (error instanceof AuditUnavailableError) throw error;
        return { ok: false, cause: 'model-failed' };
      }
      if (answer.status === 'refused') return { ok: false, cause: 'model-declined' };
      if (answer.status === 'failed') return { ok: false, cause: 'model-failed' };
      const read = readClassification(answer.text, [...source.intents.map((intent) => intent.name), ...(input.patternCatalog === undefined ? [] : [ASK_SAVED_PATTERN_INTENT])]);
      if (!read.ok) return { ok: false, cause: read.cause };
      return read.intent === null ? { ok: false, cause: 'no-intent' } : { ok: true, intent: read.intent, entities: read.entities };
    },
  };
}
