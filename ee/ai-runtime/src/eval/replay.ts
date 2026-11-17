import { promptRecordOf, type FailureCode, type ModelAnswer, type ModelProvider, type ModelRequest } from '../provider.js';

/** What a recording holds for one question: the reply text, a refusal of the model, or the code of a failed call. */
export type ReplayAnswer = { readonly reply: string } | { readonly declined: true } | { readonly failure: FailureCode };

const UNKNOWN_USAGE = { kind: 'unknown' } as const;

/**
 * A provider that answers a question with what was recorded for it, and holds no key and makes no network call. The question is the values of the request, as it is the key of a recording.
 * A question with no entry is answered as a failed call: a scorer that asks for one has already seen that it has no answer.
 */
export function replayProvider(answers: ReadonlyMap<string, ReplayAnswer>): ModelProvider {
  return {
    async complete(request: ModelRequest): Promise<ModelAnswer> {
      const prompt = promptRecordOf(request);
      const found = answers.get(request.values);
      if (found === undefined) return { status: 'failed', code: 'provider-error', usage: UNKNOWN_USAGE, prompt };
      if ('reply' in found) return { status: 'ok', text: found.reply, usage: UNKNOWN_USAGE, model: 'replay', prompt };
      if ('declined' in found) return { status: 'refused', usage: UNKNOWN_USAGE, prompt };
      return { status: 'failed', code: found.failure, usage: UNKNOWN_USAGE, prompt };
    },
  };
}
