/** What a turn has started so far: the reads that reached the source, the calls the model service received and the closing events of turns. */
export interface Started {
  readonly reads: number;
  readonly modelCalls: number;
}

/** Nothing started after the cancel: no read and no model call began beyond what had begun when the person cancelled. */
export function expectNothingStartedSince(before: Started, after: Started): void {
  if (after.reads > before.reads) throw new Error('a read of the source started after the cancel');
  if (after.modelCalls > before.modelCalls) throw new Error('a call to the model started after the cancel');
}
