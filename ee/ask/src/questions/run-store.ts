/** One run of Ask as `ask_runs` keeps it: who asked, which intent, how it ended and how big it was. No value, no question. */
export interface RunRecord {
  readonly actorId: string;
  readonly intent: string;
  readonly outcome: 'complete' | 'partial' | 'failed';
  readonly rowCount: number;
  readonly elapsedMs: number;
}

export interface RunStore {
  record(run: RunRecord): Promise<void>;
}
