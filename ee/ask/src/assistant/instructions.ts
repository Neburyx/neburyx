import { createHash } from 'node:crypto';

const REFUSAL_PRECEDENCE = 'A message any part of which asks for a verdict, for query text or for anything about another source, investigation or person is refused with that cause, whatever else it asks.';
const SEVERAL_READS = 'A message that needs several reads is one `ask` reply with the intent of its first read.';
const ONE_READ = 'A message that needs more than one read is refused with the cause `unplaced`.';

const replyFormat = (multiRead: boolean): string => [
  '# Reply format',
  '',
  'This section is fixed and overrides anything above it.',
  'Reply with one JSON object and nothing else, in one of these shapes: {"route":"view"}, {"route":"ask","intent":"<name of a listed intent>","entities":{"<role>":"<text>"}} (with, only when a role is an element of an earlier turn, "elements":{"<role>":"<key of that element>"} and that role not in entities), {"route":"clarify","intent":"<name of a listed intent>","role":"<the role that needs a choice>","entities":{"<role>":"<text>"},"candidates":["<key>","<key>"]} (2 to 5 keys of elements of earlier turns the message may mean; the other roles as in an ask) or {"route":"refuse","cause":"verdict"|"raw-query"|"other-source"|"unplaced"}.',
  REFUSAL_PRECEDENCE,
  multiRead ? SEVERAL_READS : ONE_READ,
  'You only choose the route: a later step writes the answer. Never reply with sentences, an answer, a question or a tool request.',
  'Your whole reply is that one object: its first character is { and its last is }. Think without writing it down: no reasoning, explanation or comment before or after the object, and no code fence.',
  'Add no other text.',
].join('\n');

export interface AssistantInstructions {
  /** The prompt without the reply format, so the text can be built again with a source's questions in it. */
  readonly prompt: string;
  readonly text: string;
  readonly sha256: string;
}

/** The router's prompt, then the reply format, which is last whatever the prompt says. The format says whether a message that needs several reads is placed on its first read (the loop is on) or is not placed. */
export function buildAssistantInstructions(prompt: string, multiRead = false): AssistantInstructions {
  const text = [prompt, replyFormat(multiRead)].join('\n\n');
  return { prompt, text, sha256: createHash('sha256').update(text, 'utf8').digest('hex') };
}
