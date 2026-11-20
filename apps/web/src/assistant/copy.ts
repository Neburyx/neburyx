import type { AssistantFailureKind } from '@neburyx/contracts';

export const ASSISTANT_COPY = {
  title: 'Assistant',
  close: 'Close',
  introTitle: 'Ask about this investigation',
  intro: 'Describe what is on screen, or ask the source a question. Answers cite the elements they rest on.',
  forExample: 'For example',
  examples: ['“What am I looking at?”', '“Which accounts share a device with ACC-48291?”', '“And the other device?”'],
  introNote: 'It cannot say whether something is fraud. It never writes queries.',
  fieldLabel: 'Your message',
  placeholder: 'Ask about this investigation…',
  waitingPlaceholder: 'Waiting for the answer…',
  send: 'Send',
  keys: 'Enter sends, Shift+Enter adds a line, Esc closes.',
  cancel: 'Cancel',
  cancelHint: 'Cancel stops the request. Nothing more is read once it is stopped.',
  cancelledTitle: 'Cancelled',
  cancelledBody: 'Nothing more was read and nothing was added to the graph. Your message is back in the box.',
  working: 'Working on it…',
  workingBody: 'Understanding your message and reading the source. This can take a moment.',
  continuing: 'Reading a first page…',
  routeAsk: 'Read from the source',
  routeView: 'From the view',
  routeRefuse: 'Refused',
  clarifyTitle: 'Do you mean …?',
  choiceInvalidTitle: 'Choice no longer valid',
  followUps: 'Follow-ups',
  followUpInvalidTitle: 'Follow-up no longer valid',
  followUpInvalid: 'This follow-up is no longer valid. Nothing was read.',
  clarifyCandidates: 'Elements you may mean',
  clarifyStatus: 'Awaiting your choice · nothing was read. These are elements of this investigation.',
  notAnswered: 'Not answered',
  openFilters: 'Open Filters',
  summarizeView: 'Summarize this view',
  openPaths: 'Open Paths',
  pathsLeftOut: 'Open Paths is left out because this build has no Paths tool.',
  unavailableTitle: 'Not available',
  unavailableBody: 'The assistant is not available because AI is switched off, or no AI provider is configured for this deployment.',
  unavailableNote: 'An administrator can switch AI on or set a provider. Everything else in the workspace works as before.',
  unavailableManual: 'You can still use the manual tools: Filters, Search, Expand and Paths.',
  unavailableField: 'Not available',
  unavailableSend: 'Nothing can be sent.',
  serviceTitle: 'Service unavailable',
  tooLargeTitle: 'Too large',
  limitTitle: 'Stopped at a limit',
  tryAgain: 'Try again',
  askAgain: 'Ask again',
  continue: 'Continue',
  continueInvalidTitle: 'Continue no longer valid',
  continueInvalid: 'This stop has expired, or the graph or your access changed. Ask the message again.',
  heavyBody: 'This read would be very large, so the assistant stopped before reading it. At least this many match.',
  heavyNote: 'Continue reads a first page only. Or send a narrower message.',
  viewTooLarge: 'The view holds more elements than a message may name. Narrow the view, then send again. Nothing was sent.',
  notAvailableNow: 'The assistant is not available right now.',
  steps: 'Steps',
  drafted: 'AI-drafted',
  modelTag: 'Model',
  sources: 'Sources',
  citationNumber: 'Citation',
  sentences: 'Answer from the view',
  sentencesFromReads: 'Answer from the reads',
  coverage: 'Server-authored coverage',
  accessLost: 'You no longer have access to this investigation, so the thread was cleared.',
  maskingTitle: 'Masking changed',
  maskingBody: 'The text of this thread was cleared. Ask again.',
  maskingNote: 'Answers now follow the new masking. Also shown when policy or your access changes.',
  standing: 'The thread is cleared when the investigation closes.',
  newThreadTitle: 'New thread',
  newThreadBody: 'This is a new thread. The previous thread was cleared when the investigation closed.',
  newThreadNote: 'Your graph, notes and saved views are unchanged.',
  storedHeading: 'Earlier in this thread',
  storedLoading: 'Reading the earlier turns…',
  storedFailed: 'The earlier turns of this thread could not be read.',
  storedAnswered: 'Answered',
  storedRefused: 'Refused',
  sourceChanged: 'The source changed, so messages are paused.',
  thread: 'Conversation',
  you: 'You',
} as const;

export const wordsText = (used: number, limit: number): string => `${used.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} words`;
export const wordsSpoken = (used: number, limit: number): string => `${used.toLocaleString('en-US')} of ${limit.toLocaleString('en-US')} words`;
export const hintText = (limit: number): string => `Your message goes to the model as typed. Up to ${limit.toLocaleString('en-US')} words. ${ASSISTANT_COPY.keys}`;
export const tooLongText = (words: number, limit: number): string => `Your message is ${words.toLocaleString('en-US')} words. The limit is ${limit.toLocaleString('en-US')}. Shorten it and send again.`;
export const TOO_LONG_NOTE = 'Nothing was sent. The count is exact.';

/** The sentence of an `unavailable` answer: what failed and whether a read had started, never a word of the service. */
export function unavailableSentence(kind: AssistantFailureKind, readStarted: boolean): string {
  if (!readStarted) {
    if (kind === 'timeout') return 'The assistant’s service took too long. Nothing was asked and nothing was read.';
    if (kind === 'rate-limit') return 'The assistant’s service is busy. Nothing was asked and nothing was read.';
    return 'The assistant’s service is unavailable. Nothing was asked and nothing was read.';
  }
  if (kind === 'timeout') return 'The read took too long and was stopped. It may have started.';
  if (kind === 'source-unavailable') return 'The source is not available right now. The read may have started.';
  if (kind === 'busy') return 'The source is busy right now. The read may have started.';
  if (kind === 'rate-limit') return 'You have asked too often. The read may have started.';
  return 'The read did not finish. It may have started.';
}

export const sourcesText = (count: number): string => `${count.toLocaleString('en-US')} ${count === 1 ? 'source' : 'sources'}`;
export const earlierText = (count: number): string => `${count.toLocaleString('en-US')} earlier ${count === 1 ? 'turn is' : 'turns are'} not shown.`;
export const causeText = (cause: string): string => `${cause.charAt(0).toUpperCase()}${cause.slice(1).replace(/-/g, ' ')}`;
