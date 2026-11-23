import type { AssistantRead, AssistantReadKind, ExtensionRequest } from '@neburyx/contracts';
import { subjectOf } from './reads.js';

/** Tells the client of a streamed turn which step is about to run. Every method does nothing for a request that is not streamed, and nothing here can fail a turn. */
export interface StepEmitter {
  routing(): void;
  readingView(): void;
  /** A read: the tool's name, the plain-words label of an intent that has one, and the values the registry's parameter check accepted for it (the subject, as the confirmation card shows it). */
  reading(tool: string, label: string | undefined, values?: Readonly<Record<string, string>>, kind?: AssistantReadKind): void;
  /** A read that has finished, as the answer will list it. */
  readDone(read: AssistantRead): void;
  answering(): void;
}

const emitters = new WeakMap<ExtensionRequest, StepEmitter>();

/** A copy of a request (with another signal) tells its steps to the same stream, with the same numbering. */
export function shareSteps(from: ExtensionRequest, to: ExtensionRequest): void {
  emitters.set(to, stepsOf(from));
}

function create(request: ExtensionRequest): StepEmitter {
  let n = 0;
  const send = (phase: 'routing' | 'reading-view' | 'reading' | 'read-done' | 'answering', rest: Record<string, unknown> = {}): void => {
    if (request.emit === undefined) return;
    n += 1;
    try {
      request.emit('step', { n, phase, ...rest });
    } catch {
      // an event is progress, never part of the answer: a failure to send one changes nothing
    }
  };
  return {
    routing: () => send('routing'),
    readingView: () => send('reading-view'),
    reading: (tool, label, values, kind) => {
      const subject = values === undefined ? undefined : subjectOf(values);
      send('reading', { tool: tool.slice(0, 200), ...(label === undefined ? {} : { label }), ...(subject === undefined ? {} : { subject }), ...(kind === undefined ? {} : { kind }) });
    },
    readDone: (read) => send('read-done', { read }),
    answering: () => send('answering'),
  };
}

/** The steps of one request, numbered from 1 in the order they are sent. */
export function stepsOf(request: ExtensionRequest): StepEmitter {
  let found = emitters.get(request);
  if (found === undefined) {
    found = create(request);
    emitters.set(request, found);
  }
  return found;
}
