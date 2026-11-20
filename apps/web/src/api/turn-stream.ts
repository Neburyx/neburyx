import { assistantTurnAnswerSchema, assistantTurnStreamEventSchema, type AssistantTurnAnswer } from '@neburyx/contracts';
import type { z } from 'zod';

/** One step of a streamed turn, as the server reports it. */
export type TurnStep = Omit<Extract<z.infer<typeof assistantTurnStreamEventSchema>, { event: 'step' }>, 'event'>;

/** What reading a streamed turn came to: the answer, the failure the server sent as its last line, a stream that broke the protocol, or a read that was stopped. */
export type TurnStreamOutcome =
  | { readonly kind: 'answer'; readonly answer: AssistantTurnAnswer }
  | { readonly kind: 'error'; readonly error: Record<string, unknown> }
  | { readonly kind: 'broken' }
  | { readonly kind: 'stopped' };

/** The longest line the reader takes: a line is one answer, which is bounded far below this. */
const LINE_MAX_BYTES = 1_048_576;

/**
 * Reads the body of a streamed turn (one JSON object a line) and hands each step to `onStep` in order. The last line is the answer or an error; a line that is not JSON or does not fit the contract, a line after the last one, a line that is too
 * long, and a stream that ends with no last line are a broken stream, never an answer, and nothing of the bad line is kept. Lines may arrive in any chunking, even in the middle of a multi-byte character.
 */
export async function readTurnStream(body: ReadableStream<Uint8Array> | null, onStep: (step: TurnStep) => void, signal: AbortSignal | undefined): Promise<TurnStreamOutcome> {
  if (body === null) return { kind: 'broken' };
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let rest = '';
  let last: TurnStreamOutcome | undefined;
  const take = (line: string): boolean => {
    if (last !== undefined) return false;
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return false;
    }
    const parsed = assistantTurnStreamEventSchema.safeParse(json);
    if (!parsed.success) return false;
    const event = parsed.data;
    if (event.event === 'step') {
      const { event: _event, ...step } = event;
      onStep(step);
      return true;
    }
    if (event.event === 'answer') {
      const answer = assistantTurnAnswerSchema.safeParse(event.answer);
      if (!answer.success) return false;
      last = { kind: 'answer', answer: answer.data };
    } else {
      const { event: _event, ...error } = event;
      last = { kind: 'error', error };
    }
    return true;
  };
  try {
    for (;;) {
      if (signal?.aborted === true) {
        await reader.cancel();
        return { kind: 'stopped' };
      }
      const chunk = await reader.read();
      if (chunk.done) break;
      rest += decoder.decode(chunk.value, { stream: true });
      const parts = rest.split('\n');
      rest = parts.pop() ?? '';
      for (const part of parts) {
        if (part === '') continue;
        if (part.length > LINE_MAX_BYTES || !take(part)) {
          await reader.cancel();
          return { kind: 'broken' };
        }
      }
      if (rest.length > LINE_MAX_BYTES) {
        await reader.cancel();
        return { kind: 'broken' };
      }
    }
    rest += decoder.decode();
  } catch {
    return signal?.aborted === true ? { kind: 'stopped' } : { kind: 'broken' };
  }
  if (rest.trim() !== '' && !take(rest)) return { kind: 'broken' };
  return last ?? { kind: 'broken' };
}
