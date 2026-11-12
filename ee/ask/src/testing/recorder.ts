import type { ModelAnswer, ModelProvider } from '../provider.js';
import type { FixtureReply } from './fixture.js';
import type { RecordedEntry, Recording } from './recording.js';

function replyOf(answer: ModelAnswer): FixtureReply {
  switch (answer.status) {
    case 'ok':
      return { kind: 'ok', text: answer.text, usage: answer.usage, model: answer.model };
    case 'refused':
      return { kind: 'refused', usage: answer.usage };
    case 'failed':
      return { kind: 'failed', code: answer.code };
    default: {
      const unreachable: never = answer;
      return unreachable;
    }
  }
}

export interface Recorder {
  readonly provider: ModelProvider;
  readonly recording: () => Recording;
}

/** Wraps a provider and keeps, for each prompt id and version, the answer it got. The request is never kept: its parameters hold the question and the view. */
export function createRecorder(inner: ModelProvider): Recorder {
  const entries = new Map<string, RecordedEntry>();
  return {
    provider: {
      async complete(request, signal) {
        const answer = await inner.complete(request, signal);
        entries.set(`${answer.prompt.id}@${answer.prompt.version}`, { promptId: answer.prompt.id, version: answer.prompt.version, reply: replyOf(answer) });
        return answer;
      },
    },
    recording: () => ({
      format: 1,
      entries: [...entries.values()].sort((left, right) => (left.promptId < right.promptId ? -1 : left.promptId > right.promptId ? 1 : 0) || left.version - right.version),
    }),
  };
}
