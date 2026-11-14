import { ASK_QUESTION_MAX_CODE_POINTS } from '@neburyx/contracts';

const LIMIT_TEXT = ASK_QUESTION_MAX_CODE_POINTS.toLocaleString('en-US');

export const ASK_COPY = {
  title: 'Ask',
  subtitle: 'One question at a time · read-only',
  close: 'Close',
  fieldLabel: 'Your question',
  placeholder: 'Ask about the graph in your own words',
  send: 'Send',
  cancel: 'Cancel',
  keys: 'Enter sends · Shift+Enter adds a line · Esc closes',
  intro: 'Ask picks one of this source’s question types, runs it read-only, and answers with sources. It does not remember earlier questions.',
  limitReached: 'Limit reached. Shorten the question or send it as it is.',
  sourceChanged: 'The source changed, so questions are paused.',
  asking: 'Asking…',
  askingBody: 'Working out which question type this is, then reading the source. Read-only. Nothing is changed.',
  continuing: 'Reading a first page…',
  askingNote: 'Cancel stops it. The question stays in the field.',
  understoodAs: 'Understood as',
  fromFileQuery: 'From a file query',
  savedPattern: 'Your saved pattern',
  patternPrivate: 'Only you see the name of your own pattern. Others who run Ask never see it.',
  values: 'Values taken from your question',
  start: 'Start',
  answer: 'Answer',
  sources: 'Sources',
  none: 'nothing',
  refusalTitle: 'Ask did not answer',
  yourQuestion: 'Your question, as typed',
  byHand: 'Or do it by hand',
  needs: 'Needs',
  found: 'Found',
  missing: 'Missing',
  extra: 'Extra',
  used: 'Used',
  tryAgain: 'Try again',
  askAgain: 'Ask again',
  maskingCleared: 'Masking changed, so this answer is cleared. Ask again to see it.',
  heavyBody: 'This read would be very large, so Ask stopped before reading it. At least this many match.',
  heavyNote: 'Continue reads a first page only. Or reword the question to narrow it.',
  continue: 'Continue',
  continueInvalid: 'This stop has expired, or the graph or your access changed. Ask the question again.',
  partial: 'This result is partial: the source was read only up to its limit.',
  rows: 'Rows',
  ready: 'Answer ready',
  stopped: 'Stopped before reading',
  stoppedSpoken: 'Stopped before reading: this would read a lot',
  nothingToDraw: 'This result has nothing to draw on the graph.',
  shown: 'shown',
} as const;

export const addLabel = (count: string): string => `Add ${count} to graph`;

export const addFirstLabel = (count: string, noun: string): string => `Add first ${count}${noun === '' ? '' : ` ${noun}`} to graph`;

export const limitText = (used: number): string => `${used.toLocaleString('en-US')} / ${LIMIT_TEXT}`;

export const limitSpoken = (used: number): string => `${used.toLocaleString('en-US')} of ${LIMIT_TEXT}`;

/** The titles of the failure cards: what went wrong in two or three words, before the sentence. */
export const FAILURE_TITLES = {
  service: 'Service unavailable',
  audit: 'Audit unavailable',
  continue: 'Continue no longer valid',
  cancelled: 'Cancelled',
  other: 'Not answered',
} as const;

export const CANCELLED_TEXT = 'Cancelled. No answer is shown. Your question is still in the field.';
