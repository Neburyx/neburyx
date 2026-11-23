import type { EnrichedRepeat } from './enrich.js';

export interface Prices {
  /** Dollars per million tokens. */
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** The date of the price list these are from. */
  readonly date: string;
}

export interface TurnFacts {
  readonly repeat: number;
  readonly turn: number;
  readonly traceId: string | undefined;
  readonly calls: number | undefined;
  readonly inputTokens: number | undefined;
  readonly outputTokens: number | undefined;
  readonly cacheReadTokens: number | undefined;
  readonly cacheWriteTokens: number | undefined;
  readonly ms: number;
  readonly cost: number | undefined;
  /** Why this turn's figures are incomplete, if they are: never a figure presented as complete. */
  readonly incomplete: readonly string[];
}

export interface RunFacts {
  readonly turns: readonly TurnFacts[];
  readonly callsMean: number | undefined;
  readonly callsMedian: number | undefined;
  readonly callsP95: number | undefined;
  readonly medianMs: number | undefined;
  readonly callLimit: number;
  readonly turnsAtLimit: readonly string[];
  readonly totalCost: number | undefined;
  readonly incomplete: readonly string[];
  /** True when the figures can be accepted as evidence: nothing incomplete and priced. */
  readonly evidence: boolean;
  readonly p95Verdict: string;
}

const percentile = (values: readonly number[], p: number): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};
const sum = (values: readonly (number | undefined)[]): number | undefined => (values.some((value) => value === undefined) ? undefined : values.reduce<number>((total, value) => total + (value ?? 0), 0));

/**
 * The facts of the turns of a run, from their records: calls (router, agent and summary), tokens with the cache counts of the model events, time, and cost when dated prices are given. A turn without a record, with unknown
 * usage or with a call that never ended is named and its figures are left out, never invented. The report says plainly what a p95 under a cap can and cannot show.
 */
export function factsOf(repeats: readonly EnrichedRepeat[], options: { readonly callLimit: number; readonly prices?: Prices }): RunFacts {
  const turns: TurnFacts[] = [];
  repeats.forEach((entry, repeatIndex) => {
    entry.file.turns.forEach((turn, index) => {
      const records = entry.records[index];
      const incomplete: string[] = [];
      if (records === undefined || records.run === undefined) incomplete.push('no record');
      else incomplete.push(...records.problems);
      const calls = records === undefined || records.run === undefined ? undefined : records.calls.length + records.summaryCalls;
      const callList = records?.calls ?? [];
      const callTokens = (pick: (call: (typeof callList)[number]) => number | null): number | undefined => (records === undefined || callList.some((call) => pick(call) === null) ? undefined : callList.reduce((total, call) => total + (pick(call) ?? 0), 0));
      const inputTokens = records === undefined ? undefined : callTokens((call) => call.tokensIn);
      const outputTokens = records === undefined ? undefined : callTokens((call) => call.tokensOut);
      if (records !== undefined && records.run !== undefined && (inputTokens === undefined || outputTokens === undefined)) incomplete.push('unknown token usage');
      const modelEvents = records?.events.filter((event) => event.action === 'assistant.route' || event.action === 'assistant.agent' || event.action === 'ai.case-summary') ?? [];
      const cacheOf = (pick: (event: (typeof modelEvents)[number]) => number | 'unknown' | null): number | undefined => {
        if (records === undefined || modelEvents.length === 0) return undefined;
        const values = modelEvents.map(pick);
        return values.some((value) => value === null || value === 'unknown') ? undefined : values.reduce<number>((total, value) => total + (typeof value === 'number' ? value : 0), 0);
      };
      const cacheReadTokens = cacheOf((event) => event.cacheReadTokens);
      const cacheWriteTokens = cacheOf((event) => event.cacheWriteTokens);
      let cost: number | undefined;
      if (options.prices !== undefined) {
        if (inputTokens === undefined || outputTokens === undefined || cacheReadTokens === undefined || cacheWriteTokens === undefined) incomplete.push('usage incomplete: no cost');
        else cost = (inputTokens * options.prices.input + outputTokens * options.prices.output + cacheReadTokens * options.prices.cacheRead + cacheWriteTokens * options.prices.cacheWrite) / 1_000_000;
      }
      turns.push({ repeat: repeatIndex + 1, turn: turn.n, traceId: turn.traceId, calls, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, ms: turn.ms, cost, incomplete });
    });
  });
  const callCounts = turns.flatMap((turn) => (turn.calls === undefined ? [] : [turn.calls]));
  const incomplete = turns.flatMap((turn) => turn.incomplete.map((cause) => `repeat ${turn.repeat} turn ${turn.turn}: ${cause}`));
  if (options.prices === undefined) incomplete.push('no prices given: tokens only, not accepted as evidence');
  else if (options.prices.date.trim() === '') incomplete.push('the prices carry no date: not accepted as evidence');
  const atLimit = turns.filter((turn) => turn.calls !== undefined && turn.calls >= options.callLimit).map((turn) => `repeat ${turn.repeat} turn ${turn.turn}`);
  const p95 = percentile(callCounts, 95);
  const totalCost = options.prices === undefined ? undefined : sum(turns.map((turn) => turn.cost));
  const verdict = p95 === undefined ? 'no p95: no turn has a record' : p95 <= options.callLimit ? `the measured p95 of ${p95} calls is at or under the call limit of ${options.callLimit}` : `the measured p95 of ${p95} calls is over the call limit of ${options.callLimit}`;
  const qualified = `${verdict}; a p95 measured under a cap of ${options.callLimit} cannot by itself show that ${options.callLimit} is enough: only turns that ended under the limit show demand below it (${atLimit.length} of ${turns.length} turns used all of it)`;
  return {
    turns,
    callsMean: callCounts.length === 0 ? undefined : callCounts.reduce((total, value) => total + value, 0) / callCounts.length,
    callsMedian: percentile(callCounts, 50),
    callsP95: p95,
    medianMs: percentile(turns.map((turn) => turn.ms), 50),
    callLimit: options.callLimit,
    turnsAtLimit: atLimit,
    totalCost,
    incomplete,
    evidence: incomplete.length === 0 && totalCost !== undefined,
    p95Verdict: qualified,
  };
}
