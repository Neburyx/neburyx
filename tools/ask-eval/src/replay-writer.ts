import type { Question } from './questions.js';
import type { Replay } from './types.js';

/** The template version the planner's catalog gives every template; `demo-run.test.ts` fails if the planner stops accepting it. */
export const PLAN_TEMPLATE_VERSION = 1;
const PLAN_RATIONALE = 'The question names the template and its parameters.';
const REFUSAL_REASON = 'No template answers the question.';

function replyOf(question: Question): string | undefined {
  const { expect } = question;
  switch (expect.kind) {
    case 'plan':
      return JSON.stringify({ kind: 'plan', templateId: expect.template, templateVersion: PLAN_TEMPLATE_VERSION, params: expect.params, rationale: PLAN_RATIONALE });
    case 'unsupported':
      return JSON.stringify({ kind: 'unsupported', reason: REFUSAL_REASON });
    case 'blocked':
      return undefined;
    default: {
      const unreachable: never = expect;
      return unreachable;
    }
  }
}

/** A replay in which every question gets the answer it expects, made without any model call. */
export function replayFromQuestions(questions: readonly Question[], rebuild: (question: Question) => string | undefined): Replay {
  const replay: Record<string, { plan: string }> = {};
  for (const question of questions) {
    const text = rebuild(question);
    const reply = replyOf(question);
    if (text !== undefined && reply !== undefined) replay[text] = { plan: reply };
  }
  return replay;
}
