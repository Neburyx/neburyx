import { finishAll, startRig, type Rig, type RigOptions, type Route } from './rig.js';

export interface ExpandTiming {
  /** Milliseconds of the suite's clock from the start of the manual expand to its answer. */
  readonly expandMs: number;
  /** How many AI requests held or waited for a slot of the person or the source when the expand started. */
  readonly aiInFlight: number;
}

export interface LoadScenario {
  /** AI requests in flight when the manual expand starts, by default half Ask questions and half summary clicks, whose reads the core marks as AI reads. */
  readonly aiRequests: number;
  /** How long the scripted source takes to answer a read, in the suite's clock. */
  readonly readMs: number;
  /** The share of each pool of slots AI reads may hold; absent, all of it. */
  readonly aiShare?: number;
  /** The kinds of AI request, used in turn; absent, Ask questions and summary clicks. */
  readonly kinds?: readonly Route[];
}

const DEFAULT_KINDS: readonly Route[] = ['ask', 'summary'];

/** Event-loop rounds before reads are answered, so that the next read of a request has reached the source whatever else is running. */
const SETTLE_ROUNDS = 5;

/** Answers every read held at the source, then lets `readMs` of the suite's clock pass. */
async function pass(rig: Rig, readMs: number): Promise<void> {
  for (let turns = 0; turns < SETTLE_ROUNDS; turns += 1) await rig.settle();
  for (const read of rig.held.splice(0)) read.answer();
  await rig.advance(readMs);
}

/** Times one manual expand of the person's own while `aiRequests` AI requests of the same person are running. `base` gives the rig the extension, the summarizer and the classifier. */
export async function timeManualExpand(base: RigOptions, scenario: LoadScenario): Promise<ExpandTiming> {
  const rig = await startRig({ ...base, summary: true, ...(scenario.aiShare === undefined ? {} : { aiShare: scenario.aiShare }) });
  try {
    const kinds = scenario.kinds ?? DEFAULT_KINDS;
    const ai = Array.from({ length: scenario.aiRequests }, (_, index) => rig.http(undefined, kinds[index % kinds.length] ?? 'ask'));
    await rig.until(() => scenario.aiRequests === 0 || rig.personHolds().held + rig.personHolds().waiting === scenario.aiRequests, 'the AI requests reach the slots');
    await rig.settle();
    const person = rig.personHolds();
    const aiInFlight = person.held + person.waiting;
    const startedAt = rig.now();
    let answered = false;
    const expand = rig.http(undefined, 'expand').then((answer) => ((answered = true), answer));
    for (let turn = 0; turn < 400 && !answered; turn += 1) await pass(rig, scenario.readMs);
    const expandMs = rig.now() - startedAt;
    const answer = await expand;
    if (answer.status !== 200) throw new Error(`the manual expand was answered ${answer.status}`);
    await finishAll(rig, ai);
    return { expandMs, aiInFlight };
  } finally {
    await rig.close();
  }
}
