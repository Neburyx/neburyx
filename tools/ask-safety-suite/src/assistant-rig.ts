import type { AuditEvent } from '@neburyx/contracts';
import type { ExecuteCall, ExecuteOutcome } from '../../../services/api/src/gate/executor.js';
import { startAssistantApp, type AssistantApp } from '../../../services/api/src/testing/assistant-turns.js';
import type { ModelStub } from './stub.js';

export interface AssistantRigOptions {
  readonly stub: ModelStub;
  readonly respond: (call: ExecuteCall) => ExecuteOutcome | Promise<ExecuteOutcome> | undefined;
  /** The name the source gives an entity read by its stable id. */
  readonly name?: (id: string) => string;
  /** The most steps a turn may make; the loop is on from two. */
  readonly maxSteps?: number;
  /** Mounts the stores of the extension, for a turn that may wait for a confirmation. */
  readonly stores?: boolean;
  /** A description for a type of the source's mapping, by the name of the type. */
  readonly descriptions?: Readonly<Record<string, string>>;
}

export interface AssistantRig {
  readonly stub: ModelStub;
  events(): AuditEvent[];
  readonly logs: string[];
  /** The reads that reached the source, without the schema reads of its start. */
  reads(): ExecuteCall[];
  /** One turn: the replies the model gives in order (the router's, then each step's, then the answer's), then the message. */
  turn(message: string, replies: readonly string[], over?: Record<string, unknown>): Promise<{ readonly status: number; readonly body: Record<string, unknown> }>;
  close(): Promise<void>;
}

/** The real application with the assistant on and its tool loop, the real enterprise extension over the suite's stand-in of the model service, and the real gate over a scripted source. */
export async function startAssistantRig(options: AssistantRigOptions): Promise<AssistantRig> {
  const { stub } = options;
  stub.reset();
  const app: AssistantApp = await startAssistantApp({ model: stub, ...(options.descriptions === undefined ? {} : { descriptions: options.descriptions }), respond: options.respond, ...(options.name === undefined ? {} : { name: options.name }), ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }), ...(options.stores === true ? { stores: true } : {}) });
  return {
    stub,
    events: app.events,
    logs: app.logs,
    reads: app.reads,
    turn: (message, replies, over) => {
      stub.replies.push(...replies);
      return app.turn(message, over);
    },
    close: app.close,
  };
}
